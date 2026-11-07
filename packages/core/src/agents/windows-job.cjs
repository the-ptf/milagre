const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { randomBytes } = require("node:crypto");
const { powershell, powershellEnvironment } = require("../private-files.cjs");

const jobs = new WeakMap();
// Windows CommandLineToArgvW quoting. Backslashes before quotes or the closing
// quote are doubled; arguments never become PowerShell expressions.
function quoteWindowsArgument(value) {
  value = String(value);
  if (value && !/[\s"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '"';
}

const NATIVE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class MilagreJob {
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct LIMITS { public BASIC BasicLimitInformation; public IO IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUP { public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags; public ushort showWindow,reserved2; public IntPtr reservedPointer,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct STARTUP_EX { public STARTUP startup; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
 [StructLayout(LayoutKind.Sequential)] struct INFO { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref LIMITS info,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder args,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUP_EX startup,out INFO info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,ref ACCOUNT info,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public static int Run(string app,string args,string cwd,string marker,uint parentPid) {
  IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,attributes=IntPtr.Zero,jobList=IntPtr.Zero; INFO child=new INFO(); bool assigned=false,attributesInitialized=false;
  try {
   parent=OpenProcess(0x00100000,false,parentPid); Check(parent!=IntPtr.Zero);
   job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
   LIMITS limits=new LIMITS(); limits.BasicLimitInformation.LimitFlags=0x2000;
   Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(LIMITS))));
   IntPtr attributeSize=IntPtr.Zero;
   InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeSize); Check(attributeSize!=IntPtr.Zero);
   attributes=Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes,1,0,ref attributeSize)); attributesInitialized=true;
   jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
   // PROC_THREAD_ATTRIBUTE_JOB_LIST makes assignment part of process creation.
   Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000D),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   STARTUP_EX startup=new STARTUP_EX(); startup.startup.cb=(uint)Marshal.SizeOf(typeof(STARTUP_EX)); startup.startup.flags=0x101; startup.attributes=attributes;
   startup.startup.input=GetStdHandle(-10); startup.startup.output=GetStdHandle(-11); startup.startup.error=GetStdHandle(-12);
   foreach(IntPtr handle in new IntPtr[]{startup.startup.input,startup.startup.output,startup.startup.error}) Check(SetHandleInformation(handle,1,1));
   // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED.
   Check(CreateProcess(app,new StringBuilder(args),IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref startup,out child)); assigned=true;
   Console.Error.WriteLine(marker+"PID:"+child.pid); Console.Error.Flush();
   Check(ResumeThread(child.thread)!=0xffffffff);
   uint waited=WaitForMultipleObjects(2,new IntPtr[]{child.process,parent},false,0xffffffff);
   if(waited==0) {
    uint code; Check(GetExitCodeProcess(child.process,out code));
    Console.Error.WriteLine(marker+"EXIT:"+code); Console.Error.Flush();
    Console.Out.Write(marker+"DRAIN:"+code+"\n"); Console.Out.Flush();
    // Keep the job and original process handle until the owner closes the keeper.
    while(WaitForSingleObject(parent,100)==258) {
     ACCOUNT accounting=new ACCOUNT();
     Check(QueryInformationJobObject(job,1,ref accounting,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));
     if(accounting.ActiveProcesses==0) break;
    }
   } else if(waited!=1) throw new Win32Exception(Marshal.GetLastWin32Error());
   return 0;
  } catch(Win32Exception error) {
   if(error.NativeErrorCode==2 || error.NativeErrorCode==3) {
    Console.Error.WriteLine(marker+"ERROR:ENOENT"); Console.Error.Flush();
   }
   throw;
  } finally {
   if(child.process!=IntPtr.Zero && !assigned) TerminateProcess(child.process,1);
   if(attributesInitialized) DeleteProcThreadAttributeList(attributes);
   if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
   if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList);
   if(job!=IntPtr.Zero) CloseHandle(job);
   if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
   if(child.process!=IntPtr.Zero) CloseHandle(child.process);
   if(parent!=IntPtr.Zero) CloseHandle(parent);
  }
 }
}
`;

function spawnWindowsJob(file, args, options = {}, spawnImpl = spawn) {
  const marker = `__MILAGRE_JOB_${randomBytes(16).toString("hex")}__`;
  const commandLine = [quoteWindowsArgument(file), ...args.map(options.windowsVerbatimArguments ? String : quoteWindowsArgument)].join(" ");
  const targetEnvironment = options.env || process.env;
  const modulePathName = Object.keys(targetEnvironment).find((name) => name.toLowerCase() === "psmodulepath");
  const targetPSModulePath = modulePathName === undefined ? null : targetEnvironment[modulePathName];
  const payload = Buffer.from(
    JSON.stringify({ file, commandLine, cwd: options.cwd || process.cwd(), marker, parent: process.pid, targetPSModulePath }),
    "utf8",
  ).toString("base64");
  const source = Buffer.from(NATIVE, "utf8").toString("base64");
  // Compile and decode with OS modules, then restore the application's module
  // path. CreateProcess inherits its requested environment, not helper policy.
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))); $p=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable('MILAGRE_WINDOWS_JOB_SPEC'))) | ConvertFrom-Json); [Environment]::SetEnvironmentVariable('MILAGRE_WINDOWS_JOB_SPEC',$null); [Environment]::SetEnvironmentVariable('PSModulePath',$p.targetPSModulePath); $result=[MilagreJob]::Run($p.file,$p.commandLine,$p.cwd,$p.marker,[uint32]$p.parent); exit $result } catch { [Console]::Error.WriteLine('Milagre Windows process containment failed: '+$_.Exception.Message); exit 1 }`;
  if (payload.length > 32000) throw new Error("The Windows agent command exceeds the process environment limit");
  const { windowsVerbatimArguments: _verbatim, ...keeperOptions } = options;
  // WinPS can exit before evaluating its command when launched DETACHED_PROCESS.
  // The native job contains the application; the keeper stays with its owner.
  const keeper = spawnImpl(
    powershell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {
      ...keeperOptions,
      detached: false,
      env: { ...powershellEnvironment(targetEnvironment), MILAGRE_WINDOWS_JOB_SPEC: payload },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const child = new EventEmitter();
  Object.assign(child, {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: keeper.stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    spawnfile: file,
    spawnargs: [file, ...args],
  });
  const stdio = options.stdio || ["pipe", "pipe", "pipe"];
  const ignored = (index) => stdio === "ignore" || stdio[index] === "ignore";
  if (ignored(0)) {
    keeper.stdin.end();
    child.stdin = null;
  }
  let rootExited = false;
  let closed = false;
  let drained = false;
  const close = (code, signal) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
  };
  const exit = (code, signal) => {
    if (rootExited) return;
    rootExited = true;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
    if (drained) close(code, signal);
  };
  let control = "";
  let output = Buffer.alloc(0);
  const barrier = Buffer.from(marker + "DRAIN:");
  const earlyOutput = [];
  const writeOutput = (bytes) => {
    if (bytes.length && !closed && !ignored(1)) child.stdout.write(bytes);
  };
  function readOutput(chunk) {
    output = Buffer.concat([output, chunk]);
    const at = output.indexOf(barrier);
    if (at >= 0) {
      writeOutput(output.subarray(0, at));
      output = output.subarray(at);
      const end = output.indexOf(10);
      if (end < 0) return;
      output = output.subarray(end + 1);
      drained = true;
      if (rootExited) close(child.exitCode, child.signalCode);
      return;
    }
    let keep = Math.min(output.length, barrier.length - 1);
    while (keep && !output.subarray(output.length - keep).equals(barrier.subarray(0, keep))) keep--;
    writeOutput(output.subarray(0, output.length - keep));
    output = output.subarray(output.length - keep);
  }
  keeper.stdout.on("data", (chunk) => {
    if (child.pid) readOutput(chunk);
    else earlyOutput.push(chunk);
  });
  keeper.stderr.setEncoding("utf8");
  keeper.stderr.on("data", (chunk) => {
    control += chunk;
    while (true) {
      const at = control.indexOf(marker);
      if (at < 0) {
        // Only what could start a marker waits: a line an agent printed last (a sign-in link) must arrive now, whole.
        let keep = Math.min(marker.length - 1, control.length);
        while (keep && !marker.startsWith(control.slice(-keep))) keep--;
        const held = control.length - keep;
        if (!closed && !ignored(2) && held) child.stderr.write(control.slice(0, held));
        control = control.slice(held);
        return;
      }
      if (at && !closed && !ignored(2)) child.stderr.write(control.slice(0, at));
      control = control.slice(at);
      const end = control.indexOf("\n");
      if (end < 0) return;
      const frame = control.slice(marker.length, end).trim();
      control = control.slice(end + 1);
      if (/^PID:\d+$/.test(frame)) {
        child.pid = Number(frame.slice(4));
        child.emit("spawn");
        for (const chunk of earlyOutput.splice(0)) readOutput(chunk);
      } else if (/^EXIT:\d+$/.test(frame)) exit(Number(frame.slice(5)), null);
      else if (frame === "ERROR:ENOENT")
        child.emit("error", Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT", syscall: "spawn", path: file, spawnargs: args }));
      else if (!closed && !ignored(2)) child.stderr.write(marker + frame + "\n");
    }
  });
  keeper.on("error", (error) => {
    child.emit("error", error);
    exit(null, null);
  });
  keeper.on("exit", (code, signal) => exit(code, signal));
  keeper.on("close", (code, signal) => {
    jobs.delete(child);
    if (!drained) {
      for (const chunk of earlyOutput.splice(0)) writeOutput(chunk);
      writeOutput(output);
    }
    if (control && !closed && !ignored(2)) child.stderr.write(control);
    close(child.exitCode ?? code, child.signalCode ?? signal);
  });
  child.kill = (signal = "SIGTERM") => {
    if (rootExited) return false;
    child.killed = true;
    // The keeper holds the original process handle, so its PID cannot be reused.
    if (child.pid) {
      try {
        process.kill(child.pid, signal);
        return true;
      } catch {
        return false;
      }
    }
    return keeper.kill(signal);
  };
  child.unref = () => {
    keeper.unref();
    return child;
  };
  child.ref = () => {
    keeper.ref();
    return child;
  };
  child.connected = false;
  child.isWindowsJob = true;
  jobs.set(child, keeper);
  return child;
}
async function closeWindowsJob(child) {
  const keeper = jobs.get(child);
  if (!keeper) return false;
  if (keeper.exitCode != null || keeper.signalCode != null) {
    jobs.delete(child);
    return true;
  }
  await new Promise((resolve, reject) => {
    keeper.once("close", resolve);
    keeper.once("error", reject);
    try {
      keeper.kill("SIGKILL");
    } catch (error) {
      reject(error);
    }
  });
  jobs.delete(child);
  return true;
}
function isWindowsJobActive(child) {
  const keeper = jobs.get(child);
  return Boolean(keeper && keeper.exitCode == null && keeper.signalCode == null);
}
module.exports = { spawnWindowsJob, closeWindowsJob, isWindowsJobActive, quoteWindowsArgument };
