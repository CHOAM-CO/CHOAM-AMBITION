$a = New-ScheduledTaskAction -Execute 'D:\ambition\asr\run.cmd' -WorkingDirectory 'D:\ambition\asr'
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'ambition-asr' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName 'ambition-asr'
Get-ScheduledTask -TaskName 'ambition-asr' | Select TaskName,State | Format-Table -Auto | Out-String
