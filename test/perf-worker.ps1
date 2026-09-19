# Worker performance benchmark: 5-round medians per scenario per project.
# Scenarios per project:
#   cold-full   : worker absent -> spawn + session init + full check
#   no-change   : worker warm, content unchanged (replay)
#   small-edit  : worker warm, leaf file edited (warm full re-check)
#   disk-hit    : no worker, unchanged (reference: current cache hit path)
#   no-cache    : uncached reference
param()
$projects = @(
  @{ name = "element-plus"; dir = "D:\Code\vue-tsc-go\bench\element-plus"; args = "-p tsconfig.web.json --composite false --noEmit"; leaf = "packages\components\col\src\col.vue" },
  @{ name = "vueuse";       dir = "D:\Code\vue-tsc-go\bench\vueuse";       args = "--noEmit";                                        leaf = "packages\core\_configurable.ts" },
  @{ name = "vben";         dir = "D:\Code\vue-tsc-go\bench\vue-vben-admin\apps\web-antd"; args = "--noEmit --skipLibCheck";          leaf = "src\main.ts" }
)
$bin = "D:\Code\vue-tsc-go\repo\bin\vue-tsc-go.js"
function Median($a) { $s = $a | Sort-Object; $s[[int][math]::Floor($s.Count / 2)] }
function Measure-Run($dir, $argStr, $env1) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath "node" -ArgumentList "`"$bin`" $argStr" -WorkingDirectory $dir -PassThru -NoNewWindow `
    -RedirectStandardOutput "$env:TEMP\pw-out.txt" -RedirectStandardError "$env:TEMP\pw-err.txt"
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
    Start-Sleep -Milliseconds 100
  }
  $sw.Stop()
  @{ secs = $sw.Elapsed.TotalSeconds; peakMB = [math]::Round($peak / 1MB) }
}
foreach ($proj in $projects) {
  $dir = $proj.dir; $argStr = $proj.args; $leaf = Join-Path $dir $proj.leaf
  $orig = Get-Content $leaf -Raw
  $times = @{}
  Write-Output "== $($proj.name) =="
  # warm session once (worker running with the pristine leaf)
  $env:VUE_TSC_GO_WORKER = "1"
  foreach ($round in 1..5) {
    # small-edit: worker warm, leaf edited (incremental vs session state)
    Set-Content $leaf ($orig + "`nconst __perfProbeErr: number = `"x`";`n")
    $times["small-edit"] += , (Measure-Run $dir $argStr).secs
    # restore: incremental (session holds the edited state)
    Set-Content $leaf $orig
    (Measure-Run $dir $argStr) | Out-Null
    # no-change: worker warm, content identical to the session -> replay
    $times["no-change"] += , (Measure-Run $dir $argStr).secs
  }
  # disk-hit reference (no worker)
  $env:VUE_TSC_GO_WORKER = $null; $env:VUE_TSC_GO_NO_WORKER = "1"
  foreach ($round in 1..5) { $times["disk-hit"] += , (Measure-Run $dir $argStr).secs }
  # no-cache reference
  foreach ($round in 1..5) { $times["no-cache"] += , (Measure-Run $dir ($argStr + " --no-cache")).secs }
  # worker cold: kill workers (delete meta), one run
  & powershell -NoProfile -File "D:\Code\vue-tsc-go\repo\test\kill-workers.ps1" | Out-Null
  $env:VUE_TSC_GO_NO_WORKER = $null; $env:VUE_TSC_GO_WORKER = "1"
  foreach ($round in 1..5) {
    & powershell -NoProfile -File "D:\Code\vue-tsc-go\repo\test\kill-workers.ps1" | Out-Null
    $times["worker-cold"] += , (Measure-Run $dir $argStr).secs
  }
  foreach ($k in "worker-cold", "no-change", "small-edit", "disk-hit", "no-cache") {
    "{0,-12} median {1:N2}s  (all: {2})" -f $k, (Median $times[$k]), (($times[$k] | ForEach-Object { "{0:N2}" -f $_ }) -join ", ")
  }
}
