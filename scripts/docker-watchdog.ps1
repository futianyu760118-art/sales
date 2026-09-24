# Docker Desktop 看门狗
# ------------------------------------------------------------------
# 背景：宿主物理内存紧张时，Windows 会终止 Docker Desktop 进程，
#       导致全部业务容器（含销售系统）离线，且不会自动恢复（仅在用户登录时自启一次）。
# 作用：定时检测 Docker 引擎管道；若引擎不在运行且 Docker Desktop 进程也不存在，
#       则自动拉起 Docker Desktop，容器按 restart:unless-stopped 策略自动恢复。
# 由计划任务 SalesSystem-DockerWatchdog 每 5 分钟调用一次。

$ErrorActionPreference = 'SilentlyContinue'
$pipe = '\\.\pipe\dockerDesktopLinuxEngine'
$exe  = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

# 引擎在线 → 无需处理
if (Test-Path $pipe) { exit 0 }

# Docker Desktop 进程仍在（可能正在启动/重启）→ 等待，不重复拉起
$proc = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
if ($proc) { exit 0 }

# 引擎与进程都不在 → 拉起
if (Test-Path $exe) {
  Start-Process $exe
  Add-Content -Path (Join-Path $PSScriptRoot 'docker-watchdog.log') -Value ("[{0}] Docker Desktop 不在运行，已自动拉起" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
} else {
  Add-Content -Path (Join-Path $PSScriptRoot 'docker-watchdog.log') -Value ("[{0}] 未找到 Docker Desktop 可执行文件：{1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $exe)
}
