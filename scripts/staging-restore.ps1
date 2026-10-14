# Restaura um backup de staging. SEMPRE num banco separado
# (levora_staging_restore_<timestamp> por padrão) - nunca sobrescreve o
# banco de staging em uso, nunca destrutivo por padrão.
#
# Uso:
#   .\scripts\staging-restore.ps1 -BackupFile backups\levora_staging_2026-10-01_203000.dump
#
# Depois de restaurar, o script sobe um container temporário do app
# apontado para o banco restaurado e confirma health + verifyAuditLogChain.
# O banco de teste criado NÃO é removido automaticamente - revise e
# remova manualmente quando terminar (ver docs/STAGING_OPERATIONS.md).

param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\staging-common.ps1"
Set-Location $script:StagingRoot
Get-OrCreate-StagingSecret  # docker compose interpola o compose inteiro, mesmo so pra 'run app'

if (-not (Test-Path $BackupFile)) {
  Write-Error "Arquivo de backup não encontrado: $BackupFile"
  exit 1
}
if (-not (Test-DockerRunning)) {
  Write-Error "Docker não está respondendo. Suba o staging primeiro (.\scripts\staging-up.ps1)."
  exit 1
}

$shaFile = "$BackupFile.sha256"
if (Test-Path $shaFile) {
  $expected = (Get-Content $shaFile) -split "\s+" | Select-Object -First 1
  $actual = (Get-FileHash -Path $BackupFile -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) {
    Write-Error "Checksum não bate! Esperado $expected, obtido $actual. Backup pode estar corrompido - não restaurando."
    exit 1
  }
  Write-Host "Checksum conferido." -ForegroundColor Green
} else {
  Write-Host "Aviso: sem arquivo .sha256 para conferir integridade." -ForegroundColor Yellow
}

$container = (docker compose -f $script:ComposeFile ps -q postgres)
if (-not $container) {
  Write-Error "Container do PostgreSQL de staging não está rodando."
  exit 1
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$testDb = "levora_staging_restore_$timestamp"
$fileName = Split-Path -Leaf $BackupFile
$tmpPath = "/tmp/$fileName"

Write-Host "=== Criando banco de teste separado: $testDb ===" -ForegroundColor Cyan
docker exec $container psql -U postgres -c "CREATE DATABASE $testDb;"

Write-Host "`n=== Restaurando ===" -ForegroundColor Cyan
docker cp $BackupFile "${container}:${tmpPath}"
docker exec $container pg_restore -U postgres -d $testDb $tmpPath
docker exec $container rm -f $tmpPath

Write-Host "`n=== Validando schema ===" -ForegroundColor Cyan
$tableCount = docker exec $container psql -U postgres -d $testDb -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
$migrationCount = docker exec $container psql -U postgres -d $testDb -t -c "SELECT count(*) FROM schema_migrations;"
Write-Host "Tabelas: $($tableCount.Trim())"
Write-Host "Migrations registradas: $($migrationCount.Trim())"

Write-Host "`n=== Validando aplicação contra o banco restaurado ===" -ForegroundColor Cyan
$dbUrl = "postgres://postgres:staging_only_not_real@postgres:5432/$testDb"
docker compose -f $script:ComposeFile run --rm --no-deps -d --name "levora-restore-check-$timestamp" `
  -e DATABASE_URL=$dbUrl app | Out-Null
Start-Sleep -Seconds 3
$checkLogs = docker logs "levora-restore-check-$timestamp" 2>&1
if ($checkLogs -match "Descobertos 54 endpoints") {
  Write-Host "Aplicação sobe normalmente contra o banco restaurado (54 endpoints)." -ForegroundColor Green
} else {
  Write-Host "Aviso: não confirmei os 54 endpoints no log - revise manualmente:" -ForegroundColor Yellow
  Write-Host $checkLogs
}
docker exec "levora-restore-check-$timestamp" node -e "
import('./dist-server/src/helpers/verifyAuditChain.js').then(async (m) => {
  const r = await m.verifyAuditLogChain();
  console.log('verifyAuditLogChain:', JSON.stringify(r));
}).catch(e => console.error(e));
"
docker rm -f "levora-restore-check-$timestamp" | Out-Null

Write-Host "`n=== Restore concluído ===" -ForegroundColor Green
Write-Host "Banco de teste: $testDb (NÃO removido automaticamente)."
Write-Host "Para remover: docker exec $container psql -U postgres -c 'DROP DATABASE $testDb;'"
