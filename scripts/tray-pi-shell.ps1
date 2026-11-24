<#
  pi-shell · 托盘程序
  ------------------------------------------------------------------
  双击桌面快捷方式（pi-shell.lnk 指向本脚本）后：
    - 无常驻终端窗口（自隐藏宿主控制台；supervisor cmd 以 Hidden 拉起）
    - 右下角托盘 LOGO（web\icons\pi-shell.ico，随系统浅/深色主题切换）
    - tooltip 实时显示引擎数（GET /api/engines/stats 只读轮询，2s ≤ 5s）
    - 右键菜单：引擎数信息项 / 打开页面 / 重启 / 停止

  停止口径（与 scripts/restart-pi-shell.ps1 同源）：
    health → pi pid → 父链（pi → node(bridge) → cmd(supervisor)）→ taskkill /T /F。
    引擎尚未 spawn（pid=null）的窗口期，用「端口 LISTENING owner → 父链」兜底，
    保证停止无残留。只杀 node 会被自愈循环 1 秒内拉起，必须连 cmd 树一起结束。

  单实例：
    - 已有托盘进程（命名 Mutex Global\pi-shell-tray-<port>）→ 第二个直接干净退出；
    - 端口已活（别人先起的桥）→ 不起第二个 cmd，托盘转监控态并打开页面。

  命令行动作（-Action restart|stop）与菜单点击走同一条代码路径：
    有常驻托盘 → 写信号文件 logs\tray.signal，由托盘在轮询中执行同一函数；
    无常驻托盘 → 本进程直接执行同一函数。

  崩溃自愈保留在 start-pi-shell.cmd 的 1s/2s/4s 循环里（隐藏窗口运行），
  give-up（cmd 退出且桥不可达）→ 托盘气泡提示一次，托盘本身继续存活。

  零第三方依赖：PowerShell 5.1 + WinForms NotifyIcon（Windows 专属，其他平台不涉及）。
  控制台调试入口保留：scripts\start-pi-shell.cmd。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray-pi-shell.ps1            # 托盘模式
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray-pi-shell.ps1 -Port 7788
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray-pi-shell.ps1 -Action restart
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray-pi-shell.ps1 -Action stop
  环境变量（透传给 supervisor cmd → 桥）：PI_SHELL_PORT / PI_SHELL_SESSIONS_DIR /
    PI_SHELL_NO_BROWSER / PI_SHELL_MAX_ENGINES 等，含义同 start-pi-shell.cmd。
#>
#requires -Version 5.1
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 7788,
  [ValidateSet('menu', 'restart', 'stop')]
  [string]$Action = 'menu'
)

$ErrorActionPreference = 'Stop'

# ---------- 0. 位置与常量 ----------
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot 'logs'
$LogFile = Join-Path $LogDir 'tray.log'
$SignalFile = Join-Path $LogDir 'tray.signal'
$MutexName = "Global\pi-shell-tray-$Port"
$IconLight = Join-Path $RepoRoot 'web\icons\pi-shell.ico'
$IconDark = Join-Path $RepoRoot 'web\icons\pi-shell-on-dark.ico'

if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ---------- 1. 日志（ASCII 行；>5MB 时轮转保留一份 .old，防长期采样写爆盘） ----------
function Log([string]$msg) {
  try {
    if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 5MB)) {
      Move-Item -LiteralPath $LogFile -Destination "$LogFile.old" -Force
    }
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Add-Content -LiteralPath $LogFile -Value "$ts | $msg" -Encoding ASCII
  } catch { }
}

# ---------- 2. 与桥交互（只读轮询） ----------
function Get-HealthBody {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/api/health").Content } catch { return $null }
}
function Get-EngineStats {
  try {
    $j = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/engines/stats").Content | ConvertFrom-Json
    return @{ ok = $true; count = [int]$j.count; max = [int]$j.max }
  } catch { return @{ ok = $false; count = -1; max = -1 } }
}
function WaitHealthy([int]$tries = 40) {
  for ($i = 0; $i -lt $tries; $i++) { Start-Sleep -Milliseconds 500; if (Get-HealthBody) { return $true } }
  return $false
}
function Open-Page {
  if ($env:PI_SHELL_NO_BROWSER) { return }
  try { Start-Process "http://127.0.0.1:$Port" } catch { Log "open page failed: $($_.Exception.Message)" }
}

# ---------- 3. 树杀 / 拉起（与 scripts/restart-pi-shell.ps1 同口径） ----------
# 主路径：health.pid(pi 引擎) → node(bridge/index.mjs) → cmd(supervisor) → taskkill /T /F
# 兜底：引擎未就绪（pid=null）时按「端口 LISTENING owner = node 桥」走父链，保证无残留。
function Get-TreeRootPid {
  $body = Get-HealthBody
  if ($body) {
    $piPid = ([regex]::Match($body, '"pid"\s*:\s*(\d+)')).Groups[1].Value
    if ($piPid) {
      $pi = Get-CimInstance Win32_Process -Filter "ProcessId=$piPid" -ErrorAction SilentlyContinue
      if ($pi -and $pi.ParentProcessId) {
        $bridge = Get-CimInstance Win32_Process -Filter "ProcessId=$($pi.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($bridge -and $bridge.CommandLine -match 'index\.mjs') {
          $sup = Get-CimInstance Win32_Process -Filter "ProcessId=$($bridge.ParentProcessId)" -ErrorAction SilentlyContinue
          if ($sup -and $sup.Name -match 'cmd\.exe') {
            return @{ pid = [int]$sup.ProcessId; via = 'health-pid-chain' }
          }
          return @{ pid = [int]$bridge.ProcessId; via = 'bridge-parent' }
        }
      }
    }
  }
  # 兜底：端口 → node 桥 → 父链
  try {
    $lines = netstat -ano -p TCP | Select-String ":$Port\s+.*LISTENING"
    foreach ($line in $lines) {
      $parts = ($line.ToString().Trim() -split '\s+')
      $listenPid = [int]$parts[-1]
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenPid" -ErrorAction SilentlyContinue
      if ($proc -and $proc.Name -match '^node\.exe$') {
        $sup = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($sup -and $sup.Name -match 'cmd\.exe') {
          return @{ pid = [int]$sup.ProcessId; via = 'port-fallback-chain' }
        }
        return @{ pid = $listenPid; via = 'port-fallback' }
      }
    }
  } catch { }
  return $null
}

function Invoke-TrayStop {
  $root = Get-TreeRootPid
  if (-not $root) { Log 'tray stop: nothing listening (already stopped)'; return $true }
  & taskkill /PID $($root.pid) /T /F 2>$null | Out-Null
  Log ("tray stop tree pid={0} via={1}" -f $root.pid, $root.via)
  return $true
}

function Start-ShellHidden {
  $cmdPath = Join-Path $RepoRoot 'scripts\start-pi-shell.cmd'
  $inner = 'set PI_SHELL_PORT=' + $Port + '&& call "' + $cmdPath + '"'
  return Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $inner -WindowStyle Hidden -PassThru
}

function Invoke-TrayRestart {
  Log 'tray restart begin'
  $null = Invoke-TrayStop
  Start-Sleep -Milliseconds 800
  $proc = Start-ShellHidden
  $script:ownCmdPid = if ($proc) { [int]$proc.Id } else { 0 }
  $script:gaveUp = $false
  if (-not (WaitHealthy 40)) { Log 'tray restart failed (health timeout)'; return $false }
  Log 'tray restart ok (health restored)'
  Open-Page
  return $true
}

# ---------- 4. 单实例 Mutex（探测不持有；menu 模式持有到进程退出） ----------
function Test-TrayAlive {
  $m = $null
  try {
    $m = New-Object System.Threading.Mutex($false, $MutexName)
    try {
      $got = $m.WaitOne(0)
      if ($got) { try { $m.ReleaseMutex() } catch { } ; return $false }  # 没人持有 → 托盘不在
      return $true
    } catch { return $false }  # AbandonedMutex：持有者已死
  } finally { if ($m) { $m.Dispose() } }
}

# ---------- 5. 命令行动作：经信号文件交给常驻托盘（同一条代码路径）；无托盘则本进程执行 ----------
if ($Action -ne 'menu') {
  Log "tray action begin: $Action port=$Port pid=$PID"
  $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Set-Content -LiteralPath $SignalFile -Value "$Action|$epoch" -Encoding ASCII
  $taken = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (Test-Path -LiteralPath $SignalFile)) { $taken = $true; break }
  }
  if (-not $taken) {
    # 没有常驻托盘接手（6s 超时）→ 删掉陈旧信号，本进程直接执行（与托盘菜单同函数）
    Remove-Item -LiteralPath $SignalFile -Force -ErrorAction SilentlyContinue
    if ($Action -eq 'restart') {
      if (Invoke-TrayRestart) { exit 0 } else { exit 1 }
    }
    $null = Invoke-TrayStop
    exit 0
  }
  # 常驻托盘已接手：等结果
  if ($Action -eq 'restart') {
    if (WaitHealthy 40) { Log 'tray action restart ok (handled by resident tray)'; exit 0 }
    Log 'tray action restart failed (health timeout)'; exit 1
  }
  # stop：等常驻托盘进程退出（Mutex 释放）
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-TrayAlive)) { Log 'tray action stop ok (tray exited)'; exit 0 }
  }
  Log 'tray action stop: tray still alive after 20s'; exit 1
}

# ---------- 6. menu 模式：常驻托盘 ----------
$script:trayMutex = New-Object System.Threading.Mutex($false, $MutexName)
$ownsMutex = $false
try { $ownsMutex = $script:trayMutex.WaitOne(0) } catch { $ownsMutex = $true }  # abandoned → 接手
if (-not $ownsMutex) {
  Log "tray second-instance exit (mutex held: $MutexName)"
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 隐藏宿主 powershell 的控制台窗口（任务栏不留按钮；窗口由 .lnk「最小化」规避闪黑框）
try {
  Add-Type -Name Win -Namespace PiShellNative -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
  $hwnd = [PiShellNative.Win]::GetConsoleWindow()
  if ($hwnd -ne [IntPtr]::Zero) { [void][PiShellNative.Win]::ShowWindow($hwnd, 0) }
} catch { Log "console hide failed: $($_.Exception.Message)" }

$script:ownCmdPid = 0
$script:gaveUp = $false

$body = Get-HealthBody
if ($body) {
  Log "tray monitor (bridge already up on port $Port, pid=$PID)"
  Open-Page
} else {
  $proc = Start-ShellHidden
  if ($proc) { $script:ownCmdPid = [int]$proc.Id }
  Log "tray start (launched supervisor cmd pid=$($script:ownCmdPid) port=$Port pid=$PID)"
}

# ---------- 7. 托盘图标 + 右键菜单 ----------
$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:currentIconPath = ''

function Update-TrayIconFromTheme {
  try {
    $light = $true
    $v = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop).AppsUseLightTheme
    if ($v -eq 0) { $light = $false }
    $path = if ($light) { $IconLight } else { $IconDark }
    if ($script:currentIconPath -ne $path) {
      $old = $script:notifyIcon.Icon
      $script:notifyIcon.Icon = New-Object System.Drawing.Icon($path)
      if ($old) { $old.Dispose() }
      $script:currentIconPath = $path
    }
  } catch { Log "theme icon switch skipped: $($_.Exception.Message)" }
}
Update-TrayIconFromTheme
$script:notifyIcon.Text = 'pi-shell · 启动中'
$script:notifyIcon.Visible = $true

function Invoke-TrayStopAndExit {
  try { $null = Invoke-TrayStop; Log 'tray exit (stop)' }
  catch { Log "tray exit error: $($_.Exception.Message)" }
  try { $script:notifyIcon.Visible = $false; $script:notifyIcon.Dispose() } catch { }
  [System.Windows.Forms.Application]::Exit()
}

$menu = New-Object System.Windows.Forms.ContextMenu
$script:infoItem = New-Object System.Windows.Forms.MenuItem('引擎 · 启动中')
$script:infoItem.Enabled = $false
$menu.MenuItems.Add($script:infoItem) | Out-Null
$menu.MenuItems.Add((New-Object System.Windows.Forms.MenuItem('-'))) | Out-Null
$openItem = New-Object System.Windows.Forms.MenuItem('打开页面(&O)')
$openItem.Add_Click({ Open-Page }) | Out-Null
$menu.MenuItems.Add($openItem) | Out-Null
$restartItem = New-Object System.Windows.Forms.MenuItem('重启(&R)')
$restartItem.Add_Click({ $null = Invoke-TrayRestart }) | Out-Null
$menu.MenuItems.Add($restartItem) | Out-Null
$stopItem = New-Object System.Windows.Forms.MenuItem('停止(&S)')
$stopItem.Add_Click({ Invoke-TrayStopAndExit }) | Out-Null
$menu.MenuItems.Add($stopItem) | Out-Null
$script:notifyIcon.ContextMenu = $menu

# ---------- 8. 轮询：信号（命令行动作）→ 引擎数采样 → give-up 气泡 ----------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
  try {
    # 8.1 命令行动作信号（与菜单同一条代码路径；30s 外的陈旧信号忽略）
    if (Test-Path -LiteralPath $SignalFile) {
      $sig = ''
      try { $sig = (Get-Content -LiteralPath $SignalFile -Raw).Trim() } catch { }
      Remove-Item -LiteralPath $SignalFile -Force -ErrorAction SilentlyContinue
      $parts = $sig -split '\|'
      $fresh = $false
      if ($parts.Length -ge 2) {
        $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$parts[1]
        $fresh = ($age -ge 0 -and $age -lt 30000)
      }
      if ($fresh -and $parts[0] -eq 'stop') {
        Log 'tray signal accepted: stop'
        Invoke-TrayStopAndExit
        return
      }
      if ($fresh -and $parts[0] -eq 'restart') {
        Log 'tray signal accepted: restart'
        $null = Invoke-TrayRestart
        return
      }
      Log "tray signal ignored (stale/unknown): $sig"
    }
    # 8.2 引擎数采样（间隔 2s ≤ 5s；桥不在时显示已停止/重连态，不崩）
    $st = Get-EngineStats
    if ($st.ok) {
      $script:notifyIcon.Text = "pi-shell · 引擎 $($st.count)/$($st.max)"
      $script:infoItem.Text = "引擎 $($st.count)/$($st.max)"
      Log ("tray sample engines={0}/{1} health=ok" -f $st.count, $st.max)
    } else {
      $script:notifyIcon.Text = 'pi-shell · 已停止（重连中）'
      $script:infoItem.Text = '引擎 · 已停止'
      Log 'tray sample engines=-/- health=down'
    }
    # 8.3 自愈 give-up（自己拉起的 supervisor cmd 退出且桥不可达）→ 气泡提示一次，托盘继续存活
    if ($script:ownCmdPid -gt 0 -and -not $script:gaveUp) {
      $cmdAlive = [bool](Get-Process -Id $script:ownCmdPid -ErrorAction SilentlyContinue)
      if (-not $cmdAlive -and -not $st.ok) {
        $script:gaveUp = $true
        Log 'tray give-up detected (supervisor exited, bridge down)'
        try {
          $script:notifyIcon.ShowBalloonTip(5000, 'pi-shell', 'pi-shell 自愈已放弃：桥多次崩溃后退出。查看 logs\bridge.log 后从快捷方式重新启动。', [System.Windows.Forms.ToolTipIcon]::Error)
        } catch { }
      }
    }
  } catch { Log "tick error: $($_.Exception.Message)" }
})
$timer.Start()

# ---------- 9. 主题切换（加分项：浅/深色图标随系统切换，失败不崩） ----------
try {
  [Microsoft.Win32.SystemEvents]::add_UserPreferenceChanged({
    param($sender, $e)
    if ($e.Category -eq 'Color') { Update-TrayIconFromTheme }
  })
} catch { Log 'tray theme event unavailable' }

Log "tray running pid=$PID port=$Port"
try { [System.Windows.Forms.Application]::Run() }
finally {
  $timer.Stop(); $timer.Dispose()
  try { $script:notifyIcon.Visible = $false; $script:notifyIcon.Dispose() } catch { }
}
Log 'tray process exit'
exit 0
