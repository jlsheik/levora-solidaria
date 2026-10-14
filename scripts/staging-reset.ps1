# PERIGOSO POR DEFINIÇÃO: apaga o banco de dados do staging
# (`levora_staging`) e reaplica as migrations do zero. NUNCA toca em
# nenhum outro banco (o nome do banco de staging é fixo e hardcoded
# abaixo - não lê de nenhuma variável externa, para nunca apontar sem
# querer para outro banco). Uploads NÃO são apagados por este comando
# (use staging-destroy.ps1 para isso).
#
# Exige digitar a frase de confirmação exata. Sem -Confirm, só mostra o
# que seria apagado e para.

param(
  [switch]$Confirm
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\staging-common.ps1"
Set-Location $script:StagingRoot
Get-OrCreate-StagingSecret  # docker compose interpola o compose inteiro, mesmo so pra 'ps'/'run'

$StagingDbName = "levora_staging"  # fixo de propósito - nunca parametrizável

if (-not (Test-DockerRunning)) {
  Write-Error "Docker não está respondendo."
  exit 1
}
$container = (docker compose -f $script:ComposeFile ps -q postgres)
if (-not $container) {
  Write-Error "Container do PostgreSQL de staging não está rodando."
  exit 1
}

Write-Host "=== staging-reset: isto vai APAGAR TODOS OS DADOS do banco '$StagingDbName' ===" -ForegroundColor Red
Write-Host "Depois recria o schema do zero via 'npm run db:migrate' (mecanismo oficial)." -ForegroundColor Red
Write-Host "Uploads em storage/uploads NÃO são apagados por este comando." -ForegroundColor Yellow
Write-Host ""
Write-Host "Só afeta o banco de staging ('$StagingDbName') dentro do container Docker" -ForegroundColor Yellow
Write-Host "'$script:ComposeFile' - nunca o banco de desenvolvimento local nem qualquer outro." -ForegroundColor Yellow

if (-not $Confirm) {
  Write-Host "`nNada foi apagado. Para confirmar de verdade, rode:" -ForegroundColor Cyan
  Write-Host "  .\scripts\staging-reset.ps1 -Confirm"
  exit 0
}

Write-Host "`nDigite exatamente APAGAR STAGING para confirmar:" -ForegroundColor Red
$typed = Read-Host
if ($typed -ne "APAGAR STAGING") {
  Write-Host "Confirmação não bateu - nada foi apagado." -ForegroundColor Yellow
  exit 0
}

Write-Host "`n=== Apagando e recriando o banco '$StagingDbName' ===" -ForegroundColor Cyan
docker exec $container psql -U postgres -c "DROP DATABASE IF EXISTS $StagingDbName;"
docker exec $container psql -U postgres -c "CREATE DATABASE $StagingDbName;"

Write-Host "`n=== Reaplicando migrations (mecanismo oficial) ===" -ForegroundColor Cyan
docker compose -f $script:ComposeFile run --rm --no-deps `
  -e DATABASE_URL="postgres://postgres:staging_only_not_real@postgres:5432/$StagingDbName" `
  --entrypoint npx app tsx db/migrate.ts

Write-Host "`n=== Reiniciando o app para refletir o banco limpo ===" -ForegroundColor Cyan
docker compose -f $script:ComposeFile restart app

Write-Host "`nStaging resetado. Rode .\scripts\staging-status.ps1 para confirmar." -ForegroundColor Green
