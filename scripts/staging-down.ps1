# Desliga o staging: encerra o Cloudflare Tunnel e para os containers.
# NUNCA apaga volumes (nunca usa `docker compose down -v`) - os dados
# continuam intactos para a próxima `staging-up.ps1`.
# Para apagar dados de verdade, use staging-destroy.ps1 (exige confirmação).

$ErrorActionPreference = "Continue"
. "$PSScriptRoot\staging-common.ps1"
Set-Location $script:StagingRoot
Get-OrCreate-StagingSecret  # docker compose interpola o compose inteiro, mesmo so pra 'down'

Write-Host "=== Encerrando o Cloudflare Tunnel ===" -ForegroundColor Cyan
$proc = Get-CloudflaredPid
if ($proc) {
  Stop-Process -Id $proc.Id -Force
  Remove-Item $script:CloudflaredPidFile -ErrorAction SilentlyContinue
  Write-Host "cloudflared encerrado (a URL pública para de responder agora)." -ForegroundColor Green
} else {
  Write-Host "Nenhum cloudflared rodando." -ForegroundColor Yellow
}

Write-Host "`n=== Parando os containers (volumes preservados) ===" -ForegroundColor Cyan
if (Test-DockerRunning) {
  docker compose -f $script:ComposeFile down
  Write-Host "Containers parados. Volumes postgres_data e uploads_data continuam intactos." -ForegroundColor Green
} else {
  Write-Host "Docker não está respondendo - nada para parar." -ForegroundColor Yellow
}

Write-Host "`nPara retomar depois: .\scripts\staging-up.ps1" -ForegroundColor Cyan
