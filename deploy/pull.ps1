# Runs every minute (scheduled task ambition-pull, SYSTEM). Quiet unless origin/main moved.
$ErrorActionPreference = 'Continue'
$repo  = 'D:\ambition\repo'
$log   = 'D:\ambition\logs\pull.log'
$caddy = 'D:\ambition\bin\caddy.exe'
$cfg   = 'D:\ambition\repo\deploy\Caddyfile'
# safe.directory passed per-invocation: scoped to this repo, no global git config touched
$g = @('-c', 'safe.directory=D:/ambition/repo', '-C', $repo)

function Log($m) { Add-Content -Path $log -Encoding ascii -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

$null = & git @g fetch --quiet origin 2>&1
if ($LASTEXITCODE -ne 0) { Log "fetch FAILED (exit $LASTEXITCODE)"; exit 1 }

$old = (& git @g rev-parse HEAD 2>&1 | Out-String).Trim()
$new = (& git @g rev-parse origin/main 2>&1 | Out-String).Trim()
if ($old -eq $new) { exit 0 }

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
