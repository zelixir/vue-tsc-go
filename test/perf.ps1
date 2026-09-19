# Measures wall time and peak working set (incl. child processes) of a CLI run.
# Usage: powershell -NoProfile -File perf.ps1 -CliPath <bin> -WorkDir <dir> -CliArgs "<args>"
param(
	[Parameter(Mandatory=$true)][string]$CliPath,
	[Parameter(Mandatory=$true)][string]$WorkDir,
	[Parameter(Mandatory=$true)][string]$CliArgs
)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath "node" -ArgumentList "`"$CliPath`" $CliArgs" -WorkingDirectory $WorkDir -PassThru -NoNewWindow `
	-RedirectStandardOutput "$env:TEMP\perf-out.txt" -RedirectStandardError "$env:TEMP\perf-err.txt"
$peak = 0
function Get-TreePeak([int]$rootPid) {
	$total = 0
	try { $total += (Get-Process -Id $rootPid).WorkingSet64 } catch {}
	try {
		$kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$rootPid" -ErrorAction SilentlyContinue
		foreach ($k in $kids) { $total += Get-TreePeak ([int]$k.ProcessId) }
	} catch {}
	return $total
}
while (-not $p.HasExited) {
	$ws = Get-TreePeak $p.Id
	if ($ws -gt $peak) { $peak = $ws }
	Start-Sleep -Milliseconds 250
}
$sw.Stop()
$exit = if ($null -ne $p.ExitCode) { $p.ExitCode } else { '?' }
"{0}`texit={1}`telapsed={2:N1}s`tpeakTreeWS={3:N0}MB" -f $WorkDir, $exit, $sw.Elapsed.TotalSeconds, ($peak/1MB)
