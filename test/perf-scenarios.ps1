# Measures wall time + peak process-tree working set for the 4 cache scenarios
# on a bench project, 5 rounds each, prints per-round and median lines.
# Usage:
#   powershell -NoProfile -File perf-scenarios.ps1 -WorkDir <dir> -CliArgs "<args>" -Bin <bin> -Leaf <file> [-Probe "text"]
param(
	[Parameter(Mandatory=$true)][string]$Bin,
	[Parameter(Mandatory=$true)][string]$WorkDir,
	[Parameter(Mandatory=$true)][string]$CliArgs,
	[Parameter(Mandatory=$true)][string]$Leaf,
	[string]$Probe = 'const __perfProbe: number = "x";'
)
$ErrorActionPreference = "Stop"

function Get-TreePeak([int]$rootPid) {
	$total = 0
	try { $total += (Get-Process -Id $rootPid).WorkingSet64 } catch {}
	try {
		$kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$rootPid" -ErrorAction SilentlyContinue
		foreach ($k in $kids) { $total += Get-TreePeak ([int]$k.ProcessId) }
	} catch {}
	return $total
}

function Invoke-Measured([string]$Mode) {
	$sw = [System.Diagnostics.Stopwatch]::StartNew()
	$p = Start-Process -FilePath "node" -ArgumentList "`"$Bin`" $CliArgs" -WorkingDirectory $WorkDir -PassThru -NoNewWindow `
		-RedirectStandardOutput "$env:TEMP\perfscn-out.txt" -RedirectStandardError "$env:TEMP\perfscn-err.txt"
	$null = $p.Handle
	$peak = 0
	while (-not $p.HasExited) {
		$ws = Get-TreePeak $p.Id
		if ($ws -gt $peak) { $peak = $ws }
		Start-Sleep -Milliseconds 100
	}
	try { $p.WaitForExit() | Out-Null } catch {}
	$sw.Stop()
	$exit = if ($null -ne $p.ExitCode) { $p.ExitCode } else { -1 }
	[pscustomobject]@{ Mode = $Mode; Exit = $exit; Sec = [math]::Round($sw.Elapsed.TotalSeconds, 2); PeakMB = [math]::Round($peak / 1MB, 0) }
}

function Run-Cli([string[]]$ExtraArgs, [string]$Redirect = "silence") {
	$argLine = "`"$Bin`" $CliArgs $ExtraArgs"
	if ($Redirect -eq "silence") {
		$p = Start-Process -FilePath "node" -ArgumentList $argLine -WorkingDirectory $WorkDir -PassThru -NoNewWindow `
			-RedirectStandardOutput "$env:TEMP\perfscn-out.txt" -RedirectStandardError "$env:TEMP\perfscn-err.txt"
		$null = $p.Handle
		$p.WaitForExit() | Out-Null
	} else {
		cmd /c "cd /d `"$WorkDir`" && node `"$Bin`" $CliArgs $ExtraArgs > NUL 2>&1"
	}
}

$leafPath = Join-Path $WorkDir $Leaf
$leafBackup = [System.IO.File]::ReadAllText($leafPath)

$results = @()

# ── scenario: no-cache full (5 rounds) ──
$nocacheArgs = "$CliArgs --no-cache"
function Invoke-MeasuredNoCache {
	$sw = [System.Diagnostics.Stopwatch]::StartNew()
	$p = Start-Process -FilePath "node" -ArgumentList "`"$Bin`" $nocacheArgs" -WorkingDirectory $WorkDir -PassThru -NoNewWindow `
		-RedirectStandardOutput "$env:TEMP\perfscn-out.txt" -RedirectStandardError "$env:TEMP\perfscn-err.txt"
	$null = $p.Handle
	$peak = 0
	while (-not $p.HasExited) {
		$ws = Get-TreePeak $p.Id
		if ($ws -gt $peak) { $peak = $ws }
		Start-Sleep -Milliseconds 100
	}
	try { $p.WaitForExit() | Out-Null } catch {}
	$sw.Stop()
	$exit = if ($null -ne $p.ExitCode) { $p.ExitCode } else { -1 }
	[pscustomobject]@{ Mode = "nocache-full"; Exit = $exit; Sec = [math]::Round($sw.Elapsed.TotalSeconds, 2); PeakMB = [math]::Round($peak / 1MB, 0) }
}
for ($i = 0; $i -lt 5; $i++) {
	$results += Invoke-MeasuredNoCache
	Start-Sleep -Milliseconds 800
}

# ── scenario: cached full miss (clear cache outside the measurement) ──
for ($i = 0; $i -lt 5; $i++) {
	Run-Cli @("--clear-cache")
	$results += Invoke-Measured "cache-miss-full"
	Start-Sleep -Milliseconds 800
}

# ── scenario: hit (5 rounds) ──
for ($i = 0; $i -lt 5; $i++) {
	$results += Invoke-Measured "cache-hit"
	Start-Sleep -Milliseconds 800
}

# ── scenario: small change -> incremental-sub (mutate outside the measurement) ──
for ($i = 0; $i -lt 5; $i++) {
	# restore + warm the baseline entry
	[System.IO.File]::WriteAllText($leafPath, $leafBackup)
	Run-Cli @()
	Start-Sleep -Milliseconds 300
	# mutate (unique probe per round so the run is always a real miss)
	[System.IO.File]::AppendAllText($leafPath, "`nconst __perfProbe$i`: number = `"x`";`n")
	$results += Invoke-Measured "small-change"
	# restore + re-store baseline entry
	[System.IO.File]::WriteAllText($leafPath, $leafBackup)
	Run-Cli @()
	Start-Sleep -Milliseconds 800
}

[System.IO.File]::WriteAllText($leafPath, $leafBackup)

$results | ForEach-Object { "{0}`texit={1}`t{2}s`t{3}MB" -f $_.Mode, $_.Exit, $_.Sec, $_.PeakMB }
foreach ($mode in @("nocache-full", "cache-miss-full", "cache-hit", "small-change")) {
	$rows = $results | Where-Object { $_.Mode -eq $mode } | Sort-Object Sec
	$medT = $rows[[int][math]::Floor($rows.Count / 2)].Sec
	$rows2 = $results | Where-Object { $_.Mode -eq $mode } | Sort-Object PeakMB
	$medM = $rows2[[int][math]::Floor($rows2.Count / 2)].PeakMB
	"MEDIAN $mode : ${medT}s  ${medM}MB"
}
