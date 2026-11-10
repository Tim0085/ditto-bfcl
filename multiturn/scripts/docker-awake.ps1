param([Parameter(Mandatory=$true)][string]$StopFile,[int]$ParentPid=0)
$ErrorActionPreference = 'Stop'
$parentBirth=$null
if($ParentPid -gt 0){$watched=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue;if(-not $watched){exit 0};$parentBirth=$watched.StartTime.ToUniversalTime().Ticks}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class T8bAwake {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
if ([T8bAwake]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'SetThreadExecutionState failed' }
Write-Output "T8b sleep prevention active; PID=$PID"
try { while (-not (Test-Path -LiteralPath $StopFile)) {
    if($ParentPid -gt 0){$watched=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue;if(-not $watched -or $watched.StartTime.ToUniversalTime().Ticks -ne $parentBirth){break}}
    Start-Sleep -Milliseconds 250
} }
finally { [void][T8bAwake]::SetThreadExecutionState([uint32]2147483648) }
