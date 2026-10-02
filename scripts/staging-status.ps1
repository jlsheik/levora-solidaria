# Mostra o estado atual do staging gratuito: containers, health,
# scheduler, túnel e volumes. Não sobe nem derruba nada.

$ErrorActionPreference = "Continue"
. "$PSScriptRoot\staging-common.ps1"
Set-Location $script:StagingRoot
Get-OrCreate-StagingSecret  # docker compose interpola o compose inteiro, mesmo so pra 'ps'/'logs'

Write-Host "=== Containers ===" -ForegroundColor Cyan
if (Test-DockerRunning) {
  docker compose -f $script:ComposeFile ps
} else {
  Write-Host "Docker não está respondendo." -ForegroundColor Red
}

Write-Host "`n=== Health (http://127.0.0.1:8088/_api/__health) ===" -ForegroundColor Cyan
$health = Test-StagingHealth
if ($health) {
  Write-Host ("OK - endpoints: {0}, apiVersion: {1}" -f $health.endpoints, $health.apiVersion) -ForegroundColor Green
} else {
  Write-Host "Sem resposta - aplicação fora do ar ou ainda subindo." -ForegroundColor Red
}

Write-Host "`n=== Scheduler (últimas linhas do log do app) ===" -ForegroundColor Cyan
if (Test-DockerRunning) {
  docker compose -f $script:ComposeFile logs app --tail 10 2>$null | Select-String "Agendador"
}

Write-Host "`n=== Cloudflare Tunnel ===" -ForegroundColor Cyan
$proc = Get-CloudflaredPid
$url = Get-TunnelUrl
if ($proc) {
  Write-Host "Rodando (PID $($proc.Id))." -ForegroundColor Green
  if ($url) {
    Write-Host "STAGING URL: $url" -ForegroundColor Yellow
  } else {
    Write-Host "URL ainda não disponível - veja $($script:CloudflaredLog)" -ForegroundColor Yellow
  }
} else {
  Write-Host "Não está rodando - staging só acessível localmente (se os containers estiverem de pé)." -ForegroundColor Yellow
  Write-Host "Local: http://127.0.0.1:8088"
}

Write-Host "`n=== Volumes (dados persistentes) ===" -ForegroundColor Cyan
if (Test-DockerRunning) {
  docker volume ls --filter "name=levora-solidaria" --format "table {{.Name}}\t{{.Driver}}"
}

Write-Host "`n=== Backups locais ===" -ForegroundColor Cyan
$backupsDir = Join-Path $script:StagingRoot "backups"
if (Test-Path $backupsDir) {
  Get-ChildItem $backupsDir -Filter "*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, Length, LastWriteTime | Format-Table -AutoSize
} else {
  Write-Host "Nenhum backup ainda (rode .\scripts\staging-backup.ps1)."
}
