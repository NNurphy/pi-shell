# 完全重启 pi-shell：连"守护用的 cmd 窗口"一起换掉，确保新脚本/新环境变量生效。
# 背景：只杀 node 桥时，旧的 cmd 守护会用**旧脚本**把它拉起来（旧脚本没有 Tailscale/双栈设置），
#       所以必须同时结束守护进程树，再启动一个新的启动器。
param([int]$Port = 7788)
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot

function HealthBody([int]$p) { try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$p/api/health").Content } catch { return $null } }
function WaitHealthy([int]$p, [int]$tries = 40) { for ($i=0; $i -lt $tries; $i++) { Start-Sleep -Milliseconds 500; if (HealthBody $p) { return $true } } return $false }

$body = HealthBody $Port
if ($body) {
  $piPid = ([regex]::Match($body, '"pid"\s*:\s*(\d+)')).Groups[1].Value
  if ($piPid) {
    $pi = Get-CimInstance Win32_Process -Filter "ProcessId=$piPid"
    if ($pi -and $pi.ParentProcessId) {
      $bridge = Get-CimInstance Win32_Process -Filter "ProcessId=$($pi.ParentProcessId)"
      if ($bridge -and $bridge.CommandLine -match 'index\.mjs') {
        # 结束守护 cmd 的整棵树（cmd → node → pi）
        $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$($bridge.ParentProcessId)"
        if ($supervisor -and $supervisor.Name -match 'cmd\.exe') {
          & taskkill /PID $supervisor.ProcessId /T /F | Out-Null
        } else {
          Stop-Process -Id $bridge.ProcessId -Force
        }
      }
    }
  }
}
Start-Sleep -Milliseconds 800
$cmdPath = Join-Path $repo 'scripts\start-pi-shell.cmd'
$inner = 'set PI_SHELL_PORT=' + $Port + '&& call "' + $cmdPath + '"'
Start-Process -FilePath "$env:ComSpec" -ArgumentList '/c', $inner -WindowStyle Minimized
if (-not (WaitHealthy $Port)) { Write-Host "[pi-shell] restart failed; see logs\launcher.log"; exit 1 }
$h = HealthBody $Port
$bind = ([regex]::Match($h, '"bind"\s*:\s*"([^"]*)"')).Groups[1].Value
Write-Host "[pi-shell] restarted on $Port (bind=$bind)"
Start-Process "http://127.0.0.1:$Port"
