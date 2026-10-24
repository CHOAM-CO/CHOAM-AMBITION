# Runs every minute (scheduled task ambition-pull, SYSTEM). Quiet unless origin/main moved.
$ErrorActionPreference = 'Continue'
$repo  = 'D:\ambition\repo'
$log   = 'D:\ambition\logs\pull.log'
$caddy = 'D:\ambition\bin\caddy.exe'
$cfg   = 'D:\ambition\repo\deploy\Caddyfile'
# safe.directory passed per-invocation: scoped to this repo, no global git config touched
$g = @('-c', 'safe.directory=D:/ambition/repo', '-C', $repo)

function Log($m) { Add-Content -Path $log -Encoding ascii -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

# --- API (server/): npm ci when the lockfile changed (or node_modules is missing); restart ambition-api when server/ changed.
$nodeDir  = 'D:\ambition\bin\node'
$srvDir   = 'D:\ambition\repo\server'
$depStamp = 'D:\ambition\data\.deps-lock.sha256'
function Sync-Server([bool]$serverChanged) {
  if (-not (Test-Path "$srvDir\package-lock.json")) { return }
  $lockHash = (Get-FileHash "$srvDir\package-lock.json" -Algorithm SHA256).Hash
  $stamp = if (Test-Path $depStamp) { (Get-Content $depStamp -Raw).Trim() } else { '' }
  $depsStale = ($stamp -ne $lockHash) -or -not (Test-Path "$srvDir\node_modules")
  if (-not ($serverChanged -or $depsStale)) { return }
  $note = @()
  if ($depsStale) {
    $env:Path = "$nodeDir;$env:Path"
    $env:npm_config_cache = 'D:\ambition\npm-cache'
    Push-Location $srvDir
    $o = & "$nodeDir\npm.cmd" ci --omit=dev --no-audit --no-fund 2>&1 | Out-String
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -eq 0) { Set-Content -Path $depStamp -Value $lockHash -Encoding ascii; $note += 'npm ci ok' }
    else { $t = ($o.Trim() -replace '\s+',' '); Log ("npm ci FAILED (exit $code): " + $t.Substring([Math]::Max(0, $t.Length - 300))); return }
  }
  Stop-ScheduledTask -TaskName 'ambition-api' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName 'ambition-api'
  Start-Sleep -Seconds 3
  $note += ('ambition-api restarted (state ' + (Get-ScheduledTask -TaskName 'ambition-api').State + ')')
  Log ('server: ' + ($note -join ' ; '))
}

$null = & git @g fetch --quiet origin 2>&1
if ($LASTEXITCODE -ne 0) { Log "fetch FAILED (exit $LASTEXITCODE)"; exit 1 }

$old = (& git @g rev-parse HEAD 2>&1 | Out-String).Trim()
$new = (& git @g rev-parse origin/main 2>&1 | Out-String).Trim()
if ($old -eq $new) { Sync-Server $false; exit 0 }

$changed = & git @g diff --name-only $old $new 2>&1
$null = & git @g reset --hard --quiet origin/main 2>&1
if ($LASTEXITCODE -ne 0) { Log "reset FAILED (exit $LASTEXITCODE) $old -> $new"; exit 1 }

$msg = "updated $($old.Substring(0,7)) -> $($new.Substring(0,7))"
if ($changed -contains 'deploy/Caddyfile') {
  $env:XDG_DATA_HOME   = 'D:\ambition\caddy-data'
  $env:XDG_CONFIG_HOME = 'D:\ambition\caddy-config'
  $out = & $caddy reload --config $cfg --adapter caddyfile 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { $msg += ' ; Caddyfile changed, caddy reload ok' }
  else { $msg += " ; Caddyfile changed, caddy reload FAILED: $($out.Trim() -replace '\s+',' ')" }
}
Log $msg
$serverChanged = @($changed | Where-Object { $_ -like 'server/*' }).Count -gt 0
Sync-Server $serverChanged
