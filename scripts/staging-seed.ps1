# Popula o staging com o dataset 100% sintetico de demonstracao (Fase 68).
# Roda DENTRO do container 'app' (o Postgres do staging nao publica porta no
# host): node dist-server/db/seed-staging.js, a mesma coisa que
# `npm run seed:staging` dentro do container.
#
# EXCLUSIVO de staging. O proprio seed recusa qualquer ambiente que nao seja
# staging (db/seedStagingGuard.ts) - este script apenas declara
# LEVORA_ENVIRONMENT=staging para o processo filho; o banco e o host vem do
# docker-compose.staging.yml e a guarda confere os dois. Nao faz parte do
# processo de producao.
#
# Idempotente: rodar de novo nao duplica nada. As senhas temporarias so sao
# exibidas quando o usuario e criado; para gerar novas use -ResetPasswords.
param(
  [switch]$ResetPasswords
)

$ErrorActionPreference = "Continue"
. "$PSScriptRoot\staging-common.ps1"
Set-Location $script:StagingRoot
Get-OrCreate-StagingSecret  # docker compose interpola o compose inteiro, mesmo so pra 'exec'

if (-not (Test-DockerRunning)) {
  Write-Host "Docker nao esta respondendo. Inicie o Docker Desktop e rode .\scripts\staging-up.ps1." -ForegroundColor Red
  exit 1
}

$appContainer = (docker compose -f $script:ComposeFile ps -q app)
if (-not $appContainer) {
  Write-Host "O container 'app' do staging nao esta rodando. Rode .\scripts\staging-up.ps1 primeiro." -ForegroundColor Red
  exit 1
}

$seedArgs = @()
if ($ResetPasswords) { $seedArgs += "--reset-passwords" }

Write-Host "=== Seed sintetico do staging (idempotente) ===" -ForegroundColor Cyan
docker compose -f $script:ComposeFile exec -T -e LEVORA_ENVIRONMENT=staging app node dist-server/db/seed-staging.js @seedArgs
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Host "`nSeed concluido. Veja docs/STAGING_DEMO.md para o roteiro de demonstracao." -ForegroundColor Green
} elseif ($code -eq 2) {
  Write-Host "`nSeed RECUSADO pela guarda de ambiente (nada foi tocado no banco)." -ForegroundColor Red
} else {
  Write-Host "`nSeed terminou com erro (codigo $code). Leia a saida acima." -ForegroundColor Red
}
exit $code
