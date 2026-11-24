<#
  pi-shell · 桌面快捷方式安装器
  ------------------------------------------------------------------
  一键创建 / 更新两个桌面快捷方式：
      pi-shell.lnk        -> powershell 托盘入口 scripts\tray-pi-shell.ps1
                             （无常驻终端窗口；右下角托盘右键控制：打开页面 / 重启 / 停止；
                             tooltip 实时显示引擎数。调试入口仍是 scripts\start-pi-shell.cmd 控制台模式）
      重启 pi-shell.lnk   -> scripts\restart-pi-shell.cmd（目标不变）
  图标：web\icons\pi-shell.ico（favicon.svg 的浅色变体，16/32/48/256）
  幂等：重复执行只是覆盖写同名 .lnk，无害。

  用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
          在真实桌面创建 / 更新两个快捷方式。
      ... -DesktopDir <路径>
          写到指定目录（测试 / 多用户场景），默认真实桌面。
      ... -Remove
          删除两个快捷方式（不存在也成功，退出码 0）。

  安全口径：只创建/删除本脚本名单里的两个 .lnk，绝不触碰其他桌面文件；
  不改注册表、不起进程、不碰 7788。图标来源见 scripts/make-icon.mjs。
#>
#requires -Version 5.1
param(
  [string]$DesktopDir,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

# ---------- 0. 位置 ----------
$RepoRoot = Split-Path -Parent $PSScriptRoot
$IconPath = Join-Path $RepoRoot 'web\icons\pi-shell.ico'
$TrayScript = Join-Path $RepoRoot 'scripts\tray-pi-shell.ps1'
$PowershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# .lnk「运行方式」= 最小化（7）：规避 powershell 启动瞬间的黑框闪烁；
# 托盘脚本自身会把宿主控制台彻底隐藏（任务栏不留按钮）。
$TrayWindowStyle = 7

$Links = @(
  @{
    Name = 'pi-shell.lnk'
    Target = $PowershellExe
    Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $TrayScript + '"'
    WindowStyle = $TrayWindowStyle
    Description = 'pi-shell · 托盘模式（双击启动；右下角托盘右键控制，无常驻窗口）'
  },
  @{
    Name = '重启 pi-shell.lnk'
    Target = Join-Path $RepoRoot 'scripts\restart-pi-shell.cmd'
    Description = '重启 pi-shell 桥（不用找 cmd 窗口）'
  }
)

if (-not $DesktopDir) { $DesktopDir = [Environment]::GetFolderPath('Desktop') }

function Line([string]$text) { Write-Host "  $text" }

# ---------- 1. Remove 模式 ----------
if ($Remove) {
  Write-Host "== 移除桌面快捷方式 ==" -ForegroundColor Cyan
  Line "目录：$DesktopDir"
  foreach ($link in $Links) {
    $p = Join-Path $DesktopDir $link.Name
    if (Test-Path -LiteralPath $p) {
      Remove-Item -LiteralPath $p
      Line "已删除：$($link.Name)"
    } else {
      Line "不存在（跳过）：$($link.Name)"
    }
  }
  exit 0
}

# ---------- 2. 前置检查 ----------
Write-Host "== 创建/更新桌面快捷方式 ==" -ForegroundColor Cyan
Line "目录    ：$DesktopDir"
Line "仓库根  ：$RepoRoot"

foreach ($link in $Links) {
  if (-not (Test-Path -LiteralPath $link.Target)) {
    Write-Host "FAIL  目标不存在：$($link.Target)" -ForegroundColor Red
    exit 1
  }
  if ($link.Arguments -and -not (Test-Path -LiteralPath $TrayScript)) {
    Write-Host "FAIL  托盘脚本不存在：$TrayScript" -ForegroundColor Red
    exit 1
  }
}
if (-not (Test-Path -LiteralPath $IconPath)) {
  Write-Host "FAIL  图标不存在：$IconPath（先跑 node scripts/make-icon.mjs）" -ForegroundColor Red
  exit 1
}

# ---------- 3. 写快捷方式（WScript.Shell COM，幂等覆盖） ----------
$shell = New-Object -ComObject WScript.Shell
foreach ($link in $Links) {
  $lnkPath = Join-Path $DesktopDir $link.Name
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $link.Target
  if ($link.Arguments) { $lnk.Arguments = $link.Arguments }
  if ($null -ne $link.WindowStyle) { $lnk.WindowStyle = $link.WindowStyle }
  $lnk.WorkingDirectory = $RepoRoot
  $lnk.IconLocation = "$IconPath,0"
  $lnk.Description = $link.Description
  $lnk.Save()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($lnk) | Out-Null
  Line "就绪：$($link.Name) -> $($link.Target)$(if ($link.Arguments) { ' ' + $link.Arguments })"
}
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null

exit 0
