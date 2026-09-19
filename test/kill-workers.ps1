Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*worker.js*' -and $_.CommandLine -like '*vue-tsc-go*' } | ForEach-Object {
  Write-Host ("killing " + $_.ProcessId)
  Stop-Process -Id $_.ProcessId -Force
}
