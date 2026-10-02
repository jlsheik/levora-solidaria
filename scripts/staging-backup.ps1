# Backup real do PostgreSQL de staging: pg_dump (custom format) ->
# backups/ no host (fora de qualquer volume do Postgres) -> checksum
# SHA-256. Nome com timestamp - nunca sobrescreve um backup anterior.
#
# Procedimento idêntico ao validado nas Fases 57/61, só automatizado.

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\staging-common.ps1"
Set-Location $script:StagingRoot
Get-OrCreate-StagingSecret  # docker compose interpola o compose inteiro, mesmo so pra 'ps'/'exec'

if (-not (Test-DockerRunning)) {
  Write-Error "Docker não está respondendo. Suba o staging primeiro (.\scripts\staging-up.ps1)."
  exit 1
}

$container = (docker compose -f $script:ComposeFile ps -q postgres)
if (-not $container) {
  Write-Error "Container do PostgreSQL de staging não está rodando."
  exit 1
}

$backupsDir = Join-Path $script:StagingRoot "backups"
if (-not (Test-Path $backupsDir)) { New-Item -ItemType Directory -Path $backupsDir | Out-Null }

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$fileName = "levora_staging_$timestamp.dump"
$tmpPath = "/tmp/$fileName"
$hostPath = Join-Path $backupsDir $fileName

Write-Host "=== Backup: pg_dump ===" -ForegroundColor Cyan
docker exec $container pg_dump -U postgres -Fc -Z 6 levora_staging -f $tmpPath
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump falhou."; exit 1 }

docker cp "${container}:${tmpPath}" $hostPath
docker exec $container rm -f $tmpPath

$hash = Get-FileHash -Path $hostPath -Algorithm SHA256
# ASCII puro, sem BOM - o formato padrao "sha256sum -c" não aceita BOM na frente.
[System.IO.File]::WriteAllText("$hostPath.sha256", "$($hash.Hash.ToLower())  $fileName`n", [System.Text.Encoding]::ASCII)

$size = (Get-Item $hostPath).Length
Write-Host "`nBackup criado:" -ForegroundColor Green
Write-Host "  $hostPath ($size bytes)"
Write-Host "  SHA-256: $($hash.Hash.ToLower())"
Write-Host "`nLembrete: este backup fica só neste computador - sem independência geográfica." -ForegroundColor DarkYellow
Write-Host "Copie periodicamente para outro dispositivo/nuvem pessoal se os dados de staging importarem." -ForegroundColor DarkYellow
