# Test-only: suspends one process of this session, so a real egress stops running without any hook inside it.
param([Parameter(Mandatory=$true)][int]$Id)
$ErrorActionPreference='Stop'
Add-Type -Namespace T9 -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr handle);'
$process=[System.Diagnostics.Process]::GetProcessById($Id)
$status=[T9.Native]::NtSuspendProcess($process.Handle)
if($status -ne 0){throw "NtSuspendProcess returned $status"}
"suspended $Id"
