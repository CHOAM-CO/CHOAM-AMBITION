# One-time / idempotent box setup for the API. Run elevated: powershell -NoProfile -File D:\ambition\repo\deploy\setup-api.ps1
# Everything lives under D:\ambition. Does NOT create or print the API key (secrets\api.env is placed by hand).
$ErrorActionPreference = 'Stop'
foreach ($d in 'data\sessions','data\captures','media','secrets','logs','npm-cache') { New-Item -ItemType Directory -Force -Path "D:\ambition\$d" | Out-Null }
Copy-Item D:\ambition\repo\deploy\run-api.cmd D:\ambition\bin\run-api.cmd -Force

# secrets dir: SYSTEM + Administrators only
icacls D:\ambition\secrets /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
if (Test-Path D:\ambition\secrets\api.env) { icacls D:\ambition\secrets\api.env /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null }

$act  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c D:\ambition\bin\run-api.cmd'
$trg  = New-ScheduledTaskTrigger -AtStartup
$pri  = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$set  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'ambition-api' -Action $act -Trigger $trg -Principal $pri -Settings $set -Force | Out-Null

# ambition-pull may now run npm ci: raise its 2-minute limit (our own task)
$p = Get-ScheduledTask -TaskName 'ambition-pull'
$p.Settings.ExecutionTimeLimit = 'PT10M'
Set-ScheduledTask -TaskName 'ambition-pull' -Settings $p.Settings | Out-Null
Get-ScheduledTask -TaskName 'ambition-api','ambition-pull' | Select TaskName,State | Format-Table | Out-String
