# Sobe o staging gratuito da Levora Solidária (Fase 61/62):
# PostgreSQL + Express compilado + nginx em Docker, publicado na
# internet real via Cloudflare Quick Tunnel (gratuito, sem conta).
#
# Uso:
#   .\scripts\staging-up.ps1            # sobe tudo, inclui o túnel público
#   .\scripts\staging-up.ps1 -NoTunnel  # só local (http://127.0.0.1:8088), sem expor à internet
#
# Não instala nada automaticamente - se o Docker ou o cloudflared não
# estiverem presentes, o script para e explica o que falta.

param(
  [switch]$NoTunnel
)

# "Continue", nao "Stop": comandos nativos como `docker compose` escrevem
# progresso normal em stderr (buildkit), e o Windows PowerShell 5.1 trata
# qualquer saida em stderr de um executavel nativo como um erro terminante
# quando $ErrorActionPreference = "Stop" - interrompendo o script no meio
# de um build bem-sucedido so por causa de uma linha de log do Docker.
# Achado real desta fase. Falhas de verdade continuam detectadas pelos
# checks explicitos de $LASTEXITCODE abaixo.
$ErrorActionPreference = "Continue"
. "$PSScriptRoot\staging-common.ps1"
Set-Location $script:StagingRoot

# Fase 69 - uma subida por vez. Duas execuções próximas (duplo clique, dois
# terminais) viam "nenhum cloudflared" ao mesmo tempo e criavam dois túneis
# e dois `docker compose up` concorrentes. O lock é um arquivo aberto em
# modo exclusivo; o SO o libera sozinho se o script morrer, e o cloudflared
# (ShellExecute, sem herança de handles) nunca o segura.
Ensure-RuntimeDir
try {
  $script:UpLock = [System.IO.File]::Open((Join-Path $script:RuntimeDir "staging-up.lock"),
    [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
  Write-Host "Outra execução de staging-up.ps1 já está em andamento. Aguarde ela terminar (nada foi feito)." -ForegroundColor Yellow
  exit 3
}

Write-Host "=== 1. Verificando Docker ===" -ForegroundColor Cyan
if (-not (Test-DockerRunning)) {
  Write-Host "Docker não está respondendo. Tentando iniciar o Docker Desktop..." -ForegroundColor Yellow
  $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dockerExe) {
    Start-Process $dockerExe
    Write-Host "Aguardando o Docker ficar pronto (até 90s)..."
    $ready = $false
    for ($i = 0; $i -lt 18; $i++) {
      Start-Sleep -Seconds 5
      if (Test-DockerRunning) { $ready = $true; break }
    }
    if (-not $ready) {
      Write-Error "Docker não ficou pronto a tempo. Abra o Docker Desktop manualmente e rode este script de novo."
      exit 1
    }
  } else {
    Write-Error "Docker não está instalado (ou não está no caminho padrão). Instale o Docker Desktop antes de continuar."
    exit 1
  }
}
Write-Host "Docker OK." -ForegroundColor Green

Write-Host "`n=== 2. Segredo de staging ===" -ForegroundColor Cyan
Get-OrCreate-StagingSecret
Write-Host "STAGING_JWT_SECRET carregado (não exibido)." -ForegroundColor Green

Write-Host "`n=== 3. Build e subida dos containers ===" -ForegroundColor Cyan
docker compose -f $script:ComposeFile up -d --build
if ($LASTEXITCODE -ne 0) { Write-Error "Falha ao subir os containers."; exit 1 }

Write-Host "`n=== 4. Migrations (mecanismo oficial, nunca manual) ===" -ForegroundColor Cyan
Write-Host "Aguardando o PostgreSQL ficar pronto..."
Start-Sleep -Seconds 5
$pgContainer = (docker compose -f $script:ComposeFile ps -q postgres)
# `npm run db:migrate` (schema.sql completo) é HOSTIL a idempotencia de
# proposito (CREATE TABLE sem IF NOT EXISTS, ver docs/DATABASE_RECOVERY.md) -
# só pode rodar num banco realmente vazio. Como o volume postgres_data
# persiste entre subidas (Fase 61), é preciso checar o estado real antes de
# decidir qual dos dois mecanismos oficiais usar - exatamente como o runbook
# documenta (secao 6.1 vs 6.2), nunca assumir.
$dbUrl = "postgres://postgres:staging_only_not_real@postgres:5432/levora_staging"
$schemaExists = docker exec $pgContainer psql -U postgres -d levora_staging -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL;" 2>$null
if ($schemaExists -match "t") {
  Write-Host "Banco de staging já tem schema (volume reaproveitado) - rodando db:migrate:incremental." -ForegroundColor Yellow
  docker compose -f $script:ComposeFile run --rm --no-deps -e DATABASE_URL=$dbUrl --entrypoint npx app tsx db/run-migrations.ts
} else {
  Write-Host "Banco de staging vazio - rodando db:migrate (schema completo)." -ForegroundColor Yellow
  docker compose -f $script:ComposeFile run --rm --no-deps -e DATABASE_URL=$dbUrl --entrypoint npx app tsx db/migrate.ts
}

Write-Host "`n=== 5. Aguardando a aplicação responder ===" -ForegroundColor Cyan
$health = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  $health = Test-StagingHealth
  if ($health) { break }
}
if (-not $health) {
  Write-Error "A aplicação não respondeu em http://127.0.0.1:8088/_api/__health a tempo. Rode 'docker compose -f docker-compose.staging.yml logs app' para investigar."
  exit 1
}
Write-Host "Saudável: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green

if ($NoTunnel) {
  Write-Host "`n=== Staging local pronto (sem túnel) ===" -ForegroundColor Green
  Write-Host "Local: http://127.0.0.1:8088"
  exit 0
}

Write-Host "`n=== 6. Cloudflare Quick Tunnel (gratuito, sem conta) ===" -ForegroundColor Cyan
$existing = Get-CloudflaredPid
if ($existing) {
  Write-Host "Já existe um cloudflared rodando (PID $($existing.Id))." -ForegroundColor Yellow
} else {
  $cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
  if (-not $cloudflared) {
    Write-Error "cloudflared não encontrado no PATH. Instale em https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ (gratuito) e rode este script de novo, ou use -NoTunnel para staging só local."
    exit 1
  }
  Remove-Item $script:CloudflaredLog -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $script:RuntimeDir "cloudflared.stdout.log") -ErrorAction SilentlyContinue
  # Fase 69 - causa raiz do script "preso" quando encadeado (| Select-Object,
  # captura por outro processo etc.): Start-Process COM -RedirectStandard*
  # cria o filho com herança de handles, e o cloudflared herdava o handle de
  # escrita do pipe de stdout do PowerShell pai. Quem lia esse pipe só via
  # EOF quando o túnel morria (reproduzido: 24s com redirect contra 0,2s sem
  # ele, para um filho de 25s). Correção: NÃO redirecionar nada; o próprio
  # cloudflared grava o log (incluindo a URL) em --logfile. Sem redirect, o
  # Start-Process usa ShellExecute, que não herda handles do pai.
  $proc = Start-Process -FilePath $cloudflared.Source -ArgumentList @(
      "tunnel", "--no-autoupdate", "--url", "http://localhost:8088",
      "--logfile", "`"$($script:CloudflaredLog)`"", "--loglevel", "info"
    ) -WindowStyle Hidden -PassThru
  $proc.Id | Out-File -Encoding utf8 $script:CloudflaredPidFile
  Write-Host "cloudflared iniciado (PID $($proc.Id)). Aguardando a URL pública..."
  $url = $null
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    $url = Get-TunnelUrl
    if ($url) { break }
  }
  if (-not $url) {
    Write-Error "Não consegui ler a URL pública em $($script:CloudflaredLog). Veja o arquivo diretamente."
    exit 1
  }
}

$url = Get-TunnelUrl

# Fase 69 - o nome *.trycloudflare.com só passa a existir no DNS alguns
# segundos DEPOIS de o cloudflared registrá-lo no log. Entregar a URL antes
# disso faz a primeira tentativa de abrir falhar ("nome remoto não pôde ser
# resolvido") - exatamente o que acontece numa demonstração. Espera-se aqui,
# consultando um resolvedor PÚBLICO via DoH (nunca o resolvedor local, para
# não deixar um cache negativo na própria máquina), e confirma-se o túnel
# ponta a ponta pela borda da Cloudflare com curl --resolve. Se não confirmar
# a tempo, apenas avisa: o túnel pode estar certo e só atrasado.
$tunnelReady = $false
if ($url) {
  $tunnelHost = $url -replace "^https://", ""
  Write-Host "Aguardando a URL propagar no DNS publico (alguns segundos, no maximo ~90s)..."
  $edgeIp = $null
  for ($i = 0; $i -lt 30 -and -not $edgeIp; $i++) {
    try {
      $doh = Invoke-RestMethod -Uri "https://cloudflare-dns.com/dns-query?name=$tunnelHost&type=A" -Headers @{ accept = "application/dns-json" } -TimeoutSec 5
      if ($doh.Status -eq 0 -and $doh.Answer) {
        $edgeIp = ($doh.Answer | Where-Object { $_.type -eq 1 } | Select-Object -First 1).data
      }
    } catch { }
    if (-not $edgeIp) { Start-Sleep -Seconds 3 }
  }
  if ($edgeIp) {
    for ($i = 0; $i -lt 10 -and -not $tunnelReady; $i++) {
      $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 10 --resolve "${tunnelHost}:443:${edgeIp}" "https://$tunnelHost/_api/__health"
      if ($code -eq "200") { $tunnelReady = $true } else { Start-Sleep -Seconds 3 }
    }
  }
}

Write-Host "`n=== STAGING NO AR ===" -ForegroundColor Green
Write-Host "STAGING URL:"
Write-Host "  $url" -ForegroundColor Yellow
if ($tunnelReady) {
  Write-Host "Verificada pela borda da Cloudflare (HTTPS, /_api/__health = 200): pode abrir." -ForegroundColor Green
} else {
  Write-Host "ATENCAO: nao consegui confirmar a URL pela borda da Cloudflare a tempo." -ForegroundColor Red
  Write-Host "O tunel pode so estar atrasado: aguarde ~1 minuto e rode .\scripts\staging-status.ps1." -ForegroundColor Red
}
Write-Host "Local:"
Write-Host "  http://127.0.0.1:8088"
Write-Host ""
Write-Host "Lembrete: esta URL é temporária (Quick Tunnel gratuito, sem conta)." -ForegroundColor DarkYellow
Write-Host "Ela muda a cada vez que o cloudflared é reiniciado e para de responder quando ele é encerrado." -ForegroundColor DarkYellow
Write-Host "Use .\scripts\staging-status.ps1 para ver a URL atual depois." -ForegroundColor DarkYellow
