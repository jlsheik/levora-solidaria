# Funções compartilhadas pelos scripts staging-*.ps1 (Fase 62).
# Não executa nada sozinho - importado via dot-source (". $PSScriptRoot\staging-common.ps1").

$script:StagingRoot = Split-Path -Parent $PSScriptRoot
$script:RuntimeDir = Join-Path $StagingRoot ".staging-runtime"
$script:EnvFile = Join-Path $RuntimeDir "secrets.env"
$script:CloudflaredLog = Join-Path $RuntimeDir "cloudflared.log"
$script:CloudflaredPidFile = Join-Path $RuntimeDir "cloudflared.pid"
$script:ComposeFile = Join-Path $StagingRoot "docker-compose.staging.yml"

function Ensure-RuntimeDir {
  if (-not (Test-Path $script:RuntimeDir)) {
    New-Item -ItemType Directory -Path $script:RuntimeDir | Out-Null
  }
}

function Test-DockerRunning {
  try {
    docker info *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Get-OrCreate-StagingSecret {
  Ensure-RuntimeDir
  if (-not (Test-Path $script:EnvFile)) {
    Write-Host "Gerando STAGING_JWT_SECRET novo (primeira subida deste staging) - fica só em $($script:EnvFile), nunca no Git." -ForegroundColor Yellow
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::new()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $secret = [Convert]::ToBase64String($bytes)
    "STAGING_JWT_SECRET=$secret" | Out-File -Encoding utf8 -NoNewline $script:EnvFile
    Add-Content -Path $script:EnvFile -Value ""
  }
  $line = Get-Content $script:EnvFile | Where-Object { $_ -match "^STAGING_JWT_SECRET=" }
  $value = ($line -split "=", 2)[1]
  $env:STAGING_JWT_SECRET = $value
}

function Get-CloudflaredPid {
  if (Test-Path $script:CloudflaredPidFile) {
    $pidValue = Get-Content $script:CloudflaredPidFile -ErrorAction SilentlyContinue
    if ($pidValue) {
      $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -like "*cloudflared*") {
        return $proc
      }
    }
  }
  return $null
}

function Get-TunnelUrl {
  if (Test-Path $script:CloudflaredLog) {
    $match = Select-String -Path $script:CloudflaredLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
    if ($match) {
      return $match.Matches[0].Value
    }
  }
  return $null
}

function Test-StagingHealth {
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8088/_api/__health" -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -eq 200) {
      return $resp.Content | ConvertFrom-Json
    }
  } catch {
    return $null
  }
  return $null
}
