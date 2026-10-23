const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Use the OS copy, never a program from a Project's PATH. Encoded commands contain
// constant code and base64 data; paths never become PowerShell expressions.
const powershell = () => path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
function powershellEnvironment(environment = process.env) {
  const safe = { ...environment };
  // PS7 exports modules that Windows PowerShell 5.1 cannot load. Do not import
  // user or Project modules into privileged ACL/process helper scripts either.
  for (const name of Object.keys(safe)) if (name.toLowerCase() === "psmodulepath") delete safe[name];
  safe.PSModulePath = path.win32.join(path.win32.dirname(powershell()), "Modules");
  return safe;
}
function windowsAcl(file, { mode = "verify", execFileSyncImpl = execFileSync } = {}) {
  const encoded = Buffer.from(file, "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$i = Get-Item -LiteralPath $p -Force
if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private path must not be a reparse point' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$a = Get-Acl -LiteralPath $p
$owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $me.Value) {
 ${
   mode === "protect"
     ? `
 $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
 if ($owner -ne 'S-1-5-32-544' -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Private path must be owned by the current Windows user' }
 $a.SetOwner($me)
 `
     : `throw 'Private path must be owned by the current Windows user'`
 }
}
${
  mode === "protect"
    ? `
$a.SetAccessRuleProtection($true, $false)
foreach ($r in @($a.Access)) { [void]$a.RemoveAccessRuleSpecific($r) }
$inherit = if ($i.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
foreach ($sid in @($me, $system)) {
 $r = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
 [void]$a.AddAccessRule($r)
}
# Persist only the security sections changed above. Set-Acl also attempts to
# write audit information on an already-protected path, requiring
# SeSecurityPrivilege that a normal desktop process does not have.
$i.SetAccessControl($a)
$a = Get-Acl -LiteralPath $p
`
    : ""
}
$allowed = @($me.Value, $system.Value)
$ownAccess = $false
foreach ($r in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
 if ($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
  if ($allowed -notcontains $r.IdentityReference.Value) { throw 'Private path grants access to another Windows account' }
  if ($r.IdentityReference.Value -eq $me.Value -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)) { $ownAccess = $true }
 }
}
if (-not $ownAccess) { throw 'Private path must allow the current Windows user to read it' }
`;
  execFileSyncImpl(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: powershellEnvironment(),
    encoding: "utf8",
    // Windows PowerShell 5.1 can take over 10 s to start on a busy machine (CI runners hit it); a slow start isn't a
    // permissions failure.
    timeout: 30000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function assertPrivate(file, { platform = process.platform } = {}) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`Private path must not be a symlink: ${file}`);
  if (platform === "win32") windowsAcl(file);
  else if (stat.uid !== /** @type {() => number} */ (process.getuid)() || (stat.mode & 0o777) !== (stat.isDirectory() ? 0o700 : 0o600))
    throw new Error(`Private path must be owned by you with permissions ${stat.isDirectory() ? "0700" : "0600"}: ${file}`);
}
function preparePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Not a private directory: ${directory}`);
  if (process.platform === "win32") windowsAcl(directory, { mode: "protect" });
  else assertPrivate(directory);
}
module.exports = { powershell, powershellEnvironment, windowsAcl, assertPrivate, preparePrivateDirectory };
