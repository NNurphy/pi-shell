<#
  pi-shell · 手机通过 Tailscale 访问本机（准备 / 自检脚本）
  ------------------------------------------------------------------
  dry-run（默认，不修改任何系统设置）：
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailscale-setup.ps1
  仅在你确认需要时，额外添加一条防火墙入站规则：
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailscale-setup.ps1 -Apply
      （规则限定：方向 Inbound / 协议 TCP / 本地端口 = 桥端口 / 远端地址 100.64.0.0/10）

  安全口径：桥默认只绑 127.0.0.1；本脚本不会开公网、不会改桥的默认监听、
  不会改 Tailscale 设置、不加端口转发。防火墙改动只在 -Apply 时发生，且可一键回滚。
#>
#requires -Version 5.1
param(
  [int]$Port = 0,
  [switch]$Apply
)

$ErrorActionPreference = 'Continue'
$ruleName = $null

function Section([string]$title) {
  Write-Host ""
  Write-Host "== $title ==" -ForegroundColor Cyan
}

function Line([string]$text) { Write-Host "  $text" }

# ---------- 0. 端口 ----------
if (-not $Port -or $Port -le 0) {
  $envPort = 0
  [void][int]::TryParse("$env:PI_SHELL_PORT", [ref]$envPort)
  if ($envPort -gt 0) { $Port = $envPort } else { $Port = 7788 }
}
$ruleName = "pi-shell Tailscale $Port"

Section "0. 参数"
Line "桥端口        : $Port"
Line "模式          : $(if ($Apply) { 'APPLY（会添加防火墙规则）' } else { 'dry-run（只检测，不改系统）' })"
Line "桥默认监听    : 127.0.0.1（本脚本不会改；外露只由 PI_SHELL_BIND 决定）"

# ---------- 1. Tailscale 安装 / 命令 ----------
Section "1. Tailscale 客户端"
$ts = $null
$cmd = Get-Command tailscale -ErrorAction SilentlyContinue
if ($cmd) {
  $ts = $cmd.Source
} else {
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
      (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe')
    )) {
    if ($candidate -and (Test-Path $candidate)) { $ts = $candidate; break }
  }
}

if (-not $ts) {
  Line "未找到 tailscale.exe（PATH / Program Files / LOCALAPPDATA 都没有）。"
  Line "先安装并登录：https://tailscale.com/download/windows"
  Line "装好后再跑一次本脚本。"
  exit 2
}
Line "tailscale.exe : $ts"

# ---------- 2. 登录状态 ----------
Section "2. 登录状态（tailscale status）"
$statusText = ''
$statusCode = 0
try {
  $statusText = (& $ts status 2>&1 | Out-String)
  $statusCode = $LASTEXITCODE
} catch {
  $statusText = "$($_.Exception.Message)"
  $statusCode = 1
}
$loggedOut = ($statusText -match '(?i)logged out|not logged in|未登录|Tailscale is stopped')
if ($statusCode -ne 0 -or $loggedOut) {
  Line "未登录 / 未启动（exit=$statusCode）。"
  Line "处理：打开 Tailscale 托盘图标 → Log in → 用同一账号登录（手机也要用同一账号）。"
} else {
  $peerLines = @($statusText -split "`r?`n" | Where-Object { $_ -match '\S' })
  Line "已登录，节点数（含本机）: $($peerLines.Count)"
  foreach ($l in ($peerLines | Select-Object -First 6)) { Line "  $l" }
}

# ---------- 3. 本机 100.x 地址 ----------
Section "3. 本机 Tailscale IPv4"
$ip = $null
try {
  $raw = (& $ts ip -4 2>$null | Out-String)
  $ip = @($raw -split "`r?`n" | ForEach-Object { $_.Trim().Split('%')[0].Trim() } |
      Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' } | Select-Object -First 1)
  if ($ip -is [array]) { $ip = $ip[0] }
} catch { $ip = $null }

if (-not $ip) {
  Line "拿不到 100.x 地址 → PI_SHELL_BIND=tailscale 会回落 127.0.0.1（桥仍能本机用，手机连不上）。"
  Line "先修第 2 步（登录），再重跑。"
  exit 3
}
$isCgnat = ($ip -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.')
Line "本机地址      : $ip $(if ($isCgnat) { '(100.64.0.0/10 ✔)' } else { '(警告：不在 100.64.0.0/10 段内)' })"
Line "手机访问地址  : http://${ip}:$Port"

# ---------- 4. 防火墙（只检测；-Apply 才改） ----------
Section "4. Windows 防火墙"
$rule = $null
try { $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue } catch { $rule = $null }

if ($rule) {
  Line "已存在规则 : $ruleName（$($rule.Enabled) / $($rule.Action)）"
} else {
  Line "没有名为 '$ruleName' 的入站规则。"
  Line "说明：Tailscale 自己会放行 tailnet 内到本机端口的入站（常见情况下不需要额外规则）；"
  Line "      如果手机 curl/浏览器打不通、而本机 curl 100.x 正常，才需要下面这条规则。"
}

$profile = $null
try { $profile = Get-NetFirewallProfile -Profile Private -ErrorAction SilentlyContinue } catch { $profile = $null }
if ($profile) {
  Line "Private 配置文件入站默认动作 : $($profile.DefaultInboundAction)（DefaultInboundAction=Block 时，未放行端口会被丢弃）"
}

if ($Apply) {
  if ($rule) {
    Line "跳过：规则已存在（要重建先 Remove-NetFirewallRule -DisplayName '$ruleName'）"
  } else {
    try {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -RemoteAddress '100.64.0.0/10' -Profile Any `
        -Description 'pi-shell: Tailscale-only inbound (TCP, 100.64.0.0/10)' -ErrorAction Stop | Out-Null
      Line "已添加 : $ruleName（TCP/$Port，来源限 100.64.0.0/10）"
      Line "回滚   : Remove-NetFirewallRule -DisplayName '$ruleName'"
    } catch {
      Line "添加失败：$($_.Exception.Message)"
      Line "需要「以管理员身份运行」的 PowerShell 才能改防火墙。"
    }
  }
} else {
  Line "未做任何防火墙改动（dry-run）。需要时："
  Line "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailscale-setup.ps1 -Apply -Port $Port"
}

# ---------- 5. 启动命令 ----------
Section "5. 启动桥（只在手机上用时才需要外露）"
Line "PowerShell:"
Line "  `$env:PI_SHELL_BIND='tailscale'; node bridge\src\index.mjs"
Line "cmd.exe（走启动脚本，崩溃自愈仍生效）:"
Line "  set PI_SHELL_BIND=tailscale && scripts\start-pi-shell.cmd"
Line "回到默认（只本机）: 去掉 PI_SHELL_BIND 后重启；如果它是用户级环境变量，记得 setx 删掉。"
Line "启动后看日志 logs\bridge.log 里的 bind=$(if ($ip) { $ip } else { '' }) 与 bind_banner。"

# ---------- 6. 验证 ----------
Section "6. 验证（桥起来之后）"
Line "本机自检 : curl.exe -s http://127.0.0.1:$Port/api/health   → 应含 `"bind`":`"$ip`""
Line "手机自检 : 浏览器打开 http://${ip}:$Port/api/health → JSON 里 ok=true"
Line "手机真实用 : 打开 http://${ip}:$Port ，发一条消息看是否有回复（这才算通）"

# ---------- 7. 排查清单 ----------
Section "7. 打不开时按顺序查"
Line "1) Tailscale 未登录 / 已退出：本机托盘图标是否 Logged in；tailscale status 是否列出本机与手机。"
Line "2) 手机不在同一 tailnet：手机 Tailscale 登录的账号必须与这台 PC 相同（或同一 tailnet 已共享该设备）。"
Line "3) Windows 防火墙：本机 curl 100.x 通、手机不通 → 多半是防火墙；用 -Apply 加规则或手动放行 TCP $Port（仅 100.64.0.0/10）。"
Line "4) 客户端开启屏蔽入站：Tailscale 客户端/管理台的 'Shields up'（阻止入站连接）需关闭。"
Line "5) 桥没起来 / 绑错：logs\bridge.log 搜 bind_refused / bind_adjusted / bridge_start。"
Line "6) 会话被抢占：手机与 PC 同时开同一会话会互相抢引擎 —— 同一时间只在一处用。"
Line "7) 手机丢了：立刻在 Tailscale 管理台该设备 → Remove，手机即失去访问权（详见 docs\RUNBOOK.md）。"
