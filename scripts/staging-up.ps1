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
  $stdoutDiscard = Join-Path $script:RuntimeDir "cloudflared.stdout.log"
  # cloudflared escreve o log real (incluindo a URL) em stderr, não stdout -
  # os dois precisam ir para arquivos DIFERENTES (Start-Process recusa o
  # mesmo arquivo para ambos).
  $proc = Start-Process -FilePath $cloudflared.Source -ArgumentList "tunnel","--url","http://localhost:8088" `
    -RedirectStandardError $script:CloudflaredLog -RedirectStandardOutput $stdoutDiscard `
    -WindowStyle Hidden -PassThru
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
Write-Host "`n=== STAGING NO AR ===" -ForegroundColor Green
Write-Host "STAGING URL:"
Write-Host "  $url" -ForegroundColor Yellow
Write-Host "Local:"
Write-Host "  http://127.0.0.1:8088"
Write-Host ""
Write-Host "Lembrete: esta URL é temporária (Quick Tunnel gratuito, sem conta)." -ForegroundColor DarkYellow
Write-Host "Ela muda a cada vez que o cloudflared é reiniciado e para de responder quando ele é encerrado." -ForegroundColor DarkYellow
Write-Host "Use .\scripts\staging-status.ps1 para ver a URL atual depois." -ForegroundColor DarkYellow
