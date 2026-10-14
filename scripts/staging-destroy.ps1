# O ÚNICO comando desta família que apaga dados de verdade e para
# sempre: containers + volumes (postgres_data, uploads_data) +
# backups locais em backups/. Exige digitar a frase de confirmação
# exata. Sem -Confirm, só mostra o que seria apagado.
#
# staging-down.ps1 (o comando do dia a dia) NUNCA apaga volumes - use
# este só quando quiser destruir o staging de verdade.

param(
  [switch]$Confirm,
  [switch]$KeepBackups
)

$ErrorActionPreference = "Continue"
. "$PSScriptRoot\staging-common.ps1"
Set-Location $script:StagingRoot
Get-OrCreate-StagingSecret  # docker compose interpola o compose inteiro, mesmo so pra 'down -v'

Write-Host "=== staging-destroy: isto vai APAGAR PERMANENTEMENTE ===" -ForegroundColor Red
Write-Host "  - containers do staging"
Write-Host "  - volume postgres_data (todo o banco de staging)"
Write-Host "  - volume uploads_data (todos os uploads de staging)"
if (-not $KeepBackups) {
  Write-Host "  - todos os arquivos em backups/ (.dump e .sha256)"
}
Write-Host "  - o túnel Cloudflare ativo (se houver)"
Write-Host ""
Write-Host "Nada disto afeta nenhum banco ou dado de produção - este staging nunca teve nenhum." -ForegroundColor Yellow

if (-not $Confirm) {
  Write-Host "`nNada foi apagado. Para confirmar de verdade, rode:" -ForegroundColor Cyan
  Write-Host "  .\scripts\staging-destroy.ps1 -Confirm"
  Write-Host "  (adicione -KeepBackups para preservar os arquivos em backups/)"
  exit 0
}

Write-Host "`nDigite exatamente DESTRUIR STAGING para confirmar:" -ForegroundColor Red
$typed = Read-Host
if ($typed -ne "DESTRUIR STAGING") {
  Write-Host "Confirmação não bateu - nada foi apagado." -ForegroundColor Yellow
  exit 0
}

Write-Host "`n=== Encerrando o túnel ===" -ForegroundColor Cyan
$proc = Get-CloudflaredPid
if ($proc) {
  Stop-Process -Id $proc.Id -Force
  Remove-Item $script:CloudflaredPidFile -ErrorAction SilentlyContinue
}

Write-Host "`n=== Derrubando containers e volumes ===" -ForegroundColor Cyan
if (Test-DockerRunning) {
  docker compose -f $script:ComposeFile down -v
} else {
  Write-Host "Docker não está respondendo - não foi possível remover containers/volumes via compose." -ForegroundColor Yellow
}

if (-not $KeepBackups) {
  Write-Host "`n=== Removendo backups locais ===" -ForegroundColor Cyan
  $backupsDir = Join-Path $script:StagingRoot "backups"
  if (Test-Path $backupsDir) {
    Remove-Item "$backupsDir\*" -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "`nStaging destruído por completo." -ForegroundColor Green
Write-Host "Para começar de novo do zero: .\scripts\staging-up.ps1"
