param([string]$Output,[string]$StopFile,[int]$ParentPid)
$ErrorActionPreference='Stop'
$parent=Get-Process -Id $ParentPid -ErrorAction Stop
$birth=$parent.StartTime.ToUniversalTime().Ticks
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class T8cHostCapacity {
 [StructLayout(LayoutKind.Sequential)] public struct Mem {public uint Length,Load;public ulong Total,Available,PageTotal,PageAvailable,VirtualTotal,VirtualAvailable,Extended;}
 [StructLayout(LayoutKind.Sequential)] public struct Perf {public uint Size;public UIntPtr CommitTotal,CommitLimit,CommitPeak,PhysicalTotal,PhysicalAvailable,Cache,KernelTotal,KernelPaged,KernelNonpaged,PageSize;public uint Handles,Processes,Threads;}
 [StructLayout(LayoutKind.Sequential)] public struct Ft {public uint Low,High;public ulong Value {get{return ((ulong)High<<32)|Low;}}}
 [StructLayout(LayoutKind.Sequential)] public struct PageInfo {public uint Size,Reserved;public UIntPtr TotalSize,TotalInUse,PeakUsage;}
 [UnmanagedFunctionPointer(CallingConvention.Winapi,CharSet=CharSet.Unicode)] public delegate bool PageCallback(IntPtr context,ref PageInfo info,string file);
 [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref Mem m);
 [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out Ft idle,out Ft kernel,out Ft user);
 [DllImport("psapi.dll")] static extern bool GetPerformanceInfo(ref Perf p,uint size);
 [DllImport("psapi.dll",EntryPoint="EnumPageFilesW",CharSet=CharSet.Unicode)] static extern bool EnumPageFiles(PageCallback callback,IntPtr context);
 static ulong oldIdle,oldTotal;
 public static double[] Read(){
  Mem m=new Mem();m.Length=(uint)Marshal.SizeOf(typeof(Mem));if(!GlobalMemoryStatusEx(ref m))throw new Exception("memory sample failed");
  Perf p=new Perf();p.Size=(uint)Marshal.SizeOf(typeof(Perf));if(!GetPerformanceInfo(ref p,p.Size))throw new Exception("performance sample failed");
  Ft i,k,u;if(!GetSystemTimes(out i,out k,out u))throw new Exception("CPU sample failed");ulong total=k.Value+u.Value;
  double cpu=oldTotal==0||total==oldTotal?double.NaN:100*(1-(double)(i.Value-oldIdle)/(total-oldTotal));oldIdle=i.Value;oldTotal=total;
  ulong pages=0;PageCallback cb=delegate(IntPtr context,ref PageInfo info,string file){pages+=info.TotalInUse.ToUInt64();return true;};
  if(!EnumPageFiles(cb,IntPtr.Zero))throw new Exception("page file sample failed");GC.KeepAlive(cb);
  return new double[]{m.Available,m.Total,cpu,p.Processes,p.Threads,p.CommitTotal.ToUInt64()*p.PageSize.ToUInt64(),pages*p.PageSize.ToUInt64()};
 }
}
'@
while(-not (Test-Path -LiteralPath $StopFile)){
    $current=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if(-not $current -or $current.StartTime.ToUniversalTime().Ticks -ne $birth){break}
    $v=[T8cHostCapacity]::Read()
    $row=@{at=[DateTime]::UtcNow.ToString('o');availableMemoryBytes=$v[0];totalMemoryBytes=$v[1];cpuPercent=if([double]::IsNaN($v[2])){$null}else{$v[2]};processCount=$v[3];threadCount=$v[4];committedBytes=$v[5];pagefileInUseBytes=$v[6];below500MiB=($v[0] -lt 524288000)}
    [IO.File]::AppendAllText($Output,($row|ConvertTo-Json -Compress)+"`n",[Text.UTF8Encoding]::new($false))
    Start-Sleep -Milliseconds 200
}
