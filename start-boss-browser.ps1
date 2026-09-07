param(
  [int]$Port = 9222,
  [string]$TargetUrl = 'https://www.zhipin.com/web/geek/jobs',
  [string]$DesktopName = 'boss-hidden',
  [string]$ProfileRoot = '',
  [switch]$Visible
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 默认在独立 Windows 桌面对象上启动浏览器：窗口真实存在、可渲染、可截图，
# 但不画在 Default 桌面上，因此不出现在屏幕和任务栏、永远不抢焦点。
# 只能通过 CDP 操作；MainWindowHandle=0 是预期结果，不代表没窗口。
# 需要能亲手点的窗口时加 -Visible。

if (-not ('BossHiddenDesktop' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class BossHiddenDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateDesktopW(string name, string device, IntPtr devmode, int flags, uint access, IntPtr sa);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool CloseDesktop(IntPtr h);

  [DllImport("user32.dll")]
  static extern bool EnumDesktopWindows(IntPtr desk, EnumWindowsProc cb, IntPtr param);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr param);

  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

  // 桌面已存在时 CreateDesktop 直接打开它，因此重复启动是幂等的；Default 桌面不可由 CreateDesktop 打开，需用 OpenDesktop。
  public static int Launch(string desktop, string exe, string commandLine) {
    IntPtr hDesk;
    if (string.Equals(desktop, "Default", StringComparison.OrdinalIgnoreCase)) {
      hDesk = OpenDesktopW("Default", 0, false, 0x10000000u /* GENERIC_ALL */);
    } else {
      hDesk = CreateDesktopW(desktop, null, IntPtr.Zero, 0, 0x10000000u /* GENERIC_ALL */, IntPtr.Zero);
    }
    if (hDesk == IntPtr.Zero)
      throw new Exception((string.Equals(desktop, "Default", StringComparison.OrdinalIgnoreCase) ? "OpenDesktop" : "CreateDesktop") + " 失败，Win32 错误码 " + Marshal.GetLastWin32Error());

    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = "WinSta0\\" + desktop;

    PROCESS_INFORMATION pi;
    StringBuilder cmd = new StringBuilder(commandLine, 32768);
    if (!CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi))
      throw new Exception("CreateProcess 失败，Win32 错误码 " + Marshal.GetLastWin32Error());

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    // 不 CloseDesktop：句柄随本进程退出释放，桌面由浏览器线程续命。
    return pi.dwProcessId;
  }

  // 返回该桌面上属于 pid 的可见顶层窗口数；-1 表示桌面打不开。
  public static int CountVisibleWindows(string desktop, uint pid) {
    IntPtr hDesk = OpenDesktopW(desktop, 0, false, 0x0001u /* ENUMERATE */ | 0x0100u /* READOBJECTS */);
    if (hDesk == IntPtr.Zero) return -1;
    int found = 0;
    EnumDesktopWindows(hDesk, (h, p) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h)) found++;
      return true;
    }, IntPtr.Zero);
    CloseDesktop(hDesk);
    return found;
  }
}
'@
}

function Test-Cdp {
  param([int]$Port)
  try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
    if (-not $resp.webSocketDebuggerUrl) { throw 'invalid cdp response' }
    return $resp
  } catch {
    return $null
  }
}

function Get-PortOwnerProcess {
  param([int]$Port)
  $ownerId = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  if (-not $ownerId) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
}

$workspace = Split-Path -Parent $PSCommandPath
$defaultBrowserCandidates = @(
  @{ Path = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'; Brand='Edge' },
  @{ Path = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'; Brand='Edge' },
  @{ Path = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'; Brand='Chrome' },
  @{ Path = Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'; Brand='Chrome' }
)

$selected = $defaultBrowserCandidates | Where-Object { Test-Path -LiteralPath $_.Path } | Select-Object -First 1
if (-not $selected) {
  throw "未找到 Microsoft Edge/Google Chrome 可执行文件，请先安装。"
}

$browserExe = $selected.Path
$browserBrand = $selected.Brand
$brandLower = $browserBrand.ToLower()
if (-not $ProfileRoot) {
  $ProfileRoot = Join-Path $workspace ".workbuddy\boss-$brandLower-profile"
}
$sourceFolder = if ($browserBrand -eq 'Edge') { 'Microsoft\Edge' } else { 'Google\Chrome' }
$sourceProfile = Join-Path $env:LOCALAPPDATA "$sourceFolder\User Data\Default"
$targetProfile = Join-Path $ProfileRoot 'Default'

New-Item -ItemType Directory -Force -Path $ProfileRoot | Out-Null
if (-not (Test-Path -LiteralPath $targetProfile)) {
  if (Test-Path -LiteralPath $sourceProfile) {
    Copy-Item -LiteralPath $sourceProfile -Destination $ProfileRoot -Recurse -Force
  } else {
    New-Item -ItemType Directory -Force -Path $targetProfile | Out-Null
  }
}

# 已有可用会话：如果目标桌面模式一致则复用；若当前在隐藏桌面但请求 -Visible，则重启以显示到前台 Default 桌面
$targetDesktop = if ($Visible) { 'Default' } else { $DesktopName }
$existing = Test-Cdp -Port $Port
if ($existing) {
  $ownerProcess = Get-PortOwnerProcess -Port $Port
  if (-not $ownerProcess) { throw "端口 $Port 有 CDP 响应但查不到监听进程，未操作该会话。" }
  if ($ownerProcess.ExecutablePath -ne $browserExe -or $ownerProcess.CommandLine.IndexOf($ProfileRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "端口 $Port 属于其他浏览器或 Profile，未操作该会话。"
  }
  $visibleWins = [BossHiddenDesktop]::CountVisibleWindows($targetDesktop, [uint32]$ownerProcess.ProcessId)
  if ($Visible -and $visibleWins -le 0) {
    Write-Output "端口 $Port 已有会话运行在隐藏桌面，当前请求 -Visible 前台显示，正在重启以切换至 Default 桌面..."
    Stop-Process -Id $ownerProcess.ProcessId -Force
    Start-Sleep -Seconds 1
  } else {
    Write-Output "复用已在运行的专用会话（PID $($ownerProcess.ProcessId)）"
    Write-Output "CDP 地址: $($existing.webSocketDebuggerUrl)"
    Write-Output "用户数据目录: $targetProfile"
    exit 0
  }
}

$browserArgs = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$ProfileRoot`"",
  '--new-window',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  "`"$TargetUrl`""
)

$commandLine = (@("`"$browserExe`"") + $browserArgs) -join ' '
$launchedPid = [BossHiddenDesktop]::Launch($targetDesktop, $browserExe, $commandLine)
$mode = if ($Visible) { "可见（Default 桌面，PID $launchedPid）" } else { "隐藏桌面 $DesktopName（PID $launchedPid）" }

$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  $check = Test-Cdp -Port $Port
  if ($check) {
    $owner = Get-PortOwnerProcess -Port $Port
    $ready = $false
    if ($owner) {
      $ready = [BossHiddenDesktop]::CountVisibleWindows($targetDesktop, [uint32]$owner.ProcessId) -gt 0
    }
    if ($ready) {
      Write-Output "已启动专用 BOSS 浏览器 — $mode"
      Write-Output "CDP 地址: $($check.webSocketDebuggerUrl)"
      Write-Output "用户数据目录: $targetProfile"
      if (-not $Visible) {
        Write-Output '提示：窗口不在屏幕上，只能经 CDP 操作（node workflow/boss.js ...）；MainWindowHandle=0 属正常。'
      }
      exit 0
    }
  }
  Start-Sleep -Milliseconds 500
}

throw "启动超时：未在 25 秒内在 127.0.0.1:$Port 确认 CDP 和浏览器窗口就绪（若 Profile 已被另一个没开调试端口的实例占用，请先关掉它）"
