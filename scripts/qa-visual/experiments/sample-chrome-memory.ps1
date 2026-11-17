# G4 — experimento local (NÃO é parte do qa:visual nem do CI): amostra a cada 30 s a memória (working set) e o nº de processos do Chrome de perfil `levora-qa-profile-*`
# durante uma execução do qa:visual no Windows, para comparar a tendência com a do runner Linux (linha `saúde:`). Só lê; não encerra nada.
param([string]$Out = "chrome-memory.csv", [int]$Seconds = 1500)
"hora,processos,renderizadores,workingSetMb" | Out-File -Encoding utf8 $Out
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $p = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*levora-qa-profile*' -or ($_.ParentProcessId -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*levora-qa-profile*' })) }
  if ($p) {
    $mb = [math]::Round((($p | Measure-Object WorkingSetSize -Sum).Sum) / 1MB)
    $r = ($p | Where-Object { $_.CommandLine -like '*--type=renderer*' } | Measure-Object).Count
    "{0},{1},{2},{3}" -f (Get-Date).ToString("HH:mm:ss"), ($p | Measure-Object).Count, $r, $mb | Add-Content -Encoding utf8 $Out
  }
  Start-Sleep -Seconds 30
}
