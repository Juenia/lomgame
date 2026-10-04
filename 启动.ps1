# =====================================================================
# 一键启动（《诡秘之主：群星低语》）—— 环境自检 + 缺什么装什么
#
# 直接双击 启动.ps1，或在 PowerShell 里执行：
#     .\启动.ps1
#
# 它按这个顺序走，**每一步失败都会说清楚卡在哪、怎么修**：
#
#   ① 环境自检    PowerShell / 系统架构 / 磁盘空间 / 端口 / 网络
#   ② Node       没有 → 自动下载便携版到 .node\
#                版本太低 → 同样自动下载，并用**本地那份**启动（不动系统 PATH）
#   ③ 依赖       没有 node_modules → 装；package-lock 在就用 npm ci
#   ④ 配置       没有 .env → 从 .env.example 复制
#   ⑤ 启动       起服务，打出管理后台地址
#
# 参数：
#     -SkipDownload    不自动下载 Node（只检查，缺了就直接退出）
#     -ForceDownload   即使本机 Node 够用也强制用便携版
#     -CheckOnly       只做①②，不起服务
#
# 环境变量：
#     DSH_NODE_VERSION 指定要装的版本，默认取 22.x 里最新的 LTS
#     DSH_NODE_MIRROR  Node 下载镜像（国内可设 https://npmmirror.com/mirrors/node）
#     DSH_MIRROR       npm registry 镜像
#
# 编码：本文件必须存成 **UTF-8 带 BOM**。Windows PowerShell 5.1 对无 BOM 的
#    UTF-8 会按 GBK 读，中文提示全成乱码 —— 而那恰好发生在一个给不熟的人用的脚本上。
# =====================================================================

[CmdletBinding()]
param(
    [switch]$SkipDownload,
    [switch]$ForceDownload,
    [switch]$CheckOnly
)

# ---------------------------------------------------------------------
# 输出编码：**切到 UTF-8 代码页**（注意是 chcp，不是设 [Console]::OutputEncoding）
#
# 用户反馈：「顶部检测环境的正常了，下面加载的乱码了」——
# 这条现象把根因指得很准：**同一条 stdout 里混了两种编码**。
#
#   · 顶部「环境自检」是**本脚本自己的 Write-Host** → 控制台代码页（简中 = GBK）
#   · 下面「加载」是 **npm / node 这些外部程序**的输出 → 它们固定输出 UTF-8
#
# 所以固定按任一种读都会有一半乱码。正确做法是**统一到一种**：
# 用 `chcp 65001` 把整个控制台代码页切成 UTF-8，
# 于是本脚本的 Write-Host 与所有子进程全都是 UTF-8 —— 调用方按 UTF-8 读即可。
#
# 试过但**无效**的写法（记下来免得再试）：
#   · `[Console]::OutputEncoding = UTF8`   —— stdout 被重定向时这个属性不生效
#   · `$OutputEncoding = UTF8`             —— 只管管道，不管控制台直写
#   · 用 `-Command` 在脚本之前设          —— 同样是上面那条属性，无效
#
# ⚠️ 本文件必须存成 **UTF-8 带 BOM**（见文件头）。改这个脚本时容易把 BOM 丢掉，
# 那会让 PowerShell 按 GBK 读中文注释、进而吞掉代码结构（曾报出「Try 缺少 Catch」）。
# ---------------------------------------------------------------------
# ⚠️ chcp 必须重定向到 $null，**不能进管道** —— chcp.com 是控制台程序，
# 进管道会报「无法在管道中激活文档」并且**编码根本没切**（我第一版就写成 `| Out-Null`，白试了一轮）。
chcp.com 65001 > $null 2>&1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------
# 输出编码：**必须钉死成 UTF-8**
#
# 用户反馈：「日志最开始显示乱码，后面又正常了」——
# 根因是 PowerShell 5.1 的默认输出编码是**控制台代码页**（简中 = GBK/936），
# 而桌面启动器按 UTF-8 读子进程的 stdout，于是开头那段中文全成乱码。
# （「后面又正常」是因为某个环节之后编码被别的程序改掉了 —— 这种「一半正常」
#   最难查，所以这里不再依赖环境，直接在**第一行就定死**。）
#
# 两个都要设，各管一段：
#   · `[Console]::OutputEncoding` —— Write-Host / 控制台直写
#   · `$OutputEncoding`          —— 管道与 Write-Output
# try 包着是因为有的宿主（ISE / 某些 CI）不让改这个，那时保持原样即可。
# ---------------------------------------------------------------------
# 注意：这里**不要**去设 [Console]::OutputEncoding。
# 实测过了：stdout 被重定向时那个设置**不生效**，而且会和调用方（桌面启动器）
# 假定的编码打架。调用方按「中文 Windows 控制台代码页（GBK/936）」读，
# 那正是 PowerShell 5.1 在重定向下实际输出的编码 —— 两边对齐即可。

Set-Location -Path $PSScriptRoot
$Root = $PSScriptRoot

# ---------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------

# Node 下限：这是**实测出来的**，不是抄的。两条硬要求取较高者：
#   1. 直接跑 .ts（node src/main.ts）—— 类型剥离 22.6 引入（要标志），22.18 起默认可用
#   2. node:sqlite —— 22.5 引入，23.4 转稳定
# 实测 Node 22.20.0 跑全量 1148 条测试全绿。
$MinMajor = 22
$MinMinor = 18

# 便携版装在仓库内的隐藏目录（已加进 .gitignore）
$NodeDir = Join-Path $Root '.node'

# 下载源。官方源在国内可能很慢，所以镜像可以覆盖。
if ($env:DSH_NODE_MIRROR) { $NodeDistBase = $env:DSH_NODE_MIRROR } else { $NodeDistBase = 'https://nodejs.org/dist' }
$NpmRegistry = $env:DSH_MIRROR

$Port = 3100
$NeedDiskGB = 2

# ---------------------------------------------------------------------
# 输出小工具
# ---------------------------------------------------------------------

function Write-Head($text) {
    Write-Host ''
    Write-Host ('=' * 58) -ForegroundColor DarkGray
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host ('=' * 58) -ForegroundColor DarkGray
}
function Write-Step($text) { Write-Host "  --> $text" -ForegroundColor White }
function Write-Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  [注意] $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "  [错误] $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "         $text" -ForegroundColor DarkGray }

function Stop-Here($why) {
    Write-Host ''
    Write-Err $why
    Read-Host '按回车退出'
    exit 1
}

# ---------------------------------------------------------------------
# ① 环境自检
# ---------------------------------------------------------------------

Write-Head '诡秘之主：群星低语 —— 一键启动'
Write-Step '环境自检'

# 系统架构 → 决定下载哪个包
switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { $arch = 'x64' }
    'ARM64' { $arch = 'arm64' }
    'x86'   { $arch = 'x86' }
    default { $arch = $null }
}
if ($null -eq $arch) {
    Stop-Here "不认识的系统架构：$env:PROCESSOR_ARCHITECTURE。请手动安装 Node >= $MinMajor.$MinMinor。"
}
Write-Ok "系统架构 $env:PROCESSOR_ARCHITECTURE（下载包用 win-$arch）"

# 磁盘空间（Node 便携版约 80MB、依赖约 100MB，留 2GB 富余）
try {
    $drive = (Get-Item $Root).PSDrive.Name
    $freeGB = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
    if ($freeGB -lt $NeedDiskGB) {
        Stop-Here "磁盘空间不足：$drive 盘只剩 $freeGB GB，建议至少 $NeedDiskGB GB。"
    }
    Write-Ok "磁盘空间 $freeGB GB（$drive 盘）"
} catch {
    Write-Warn2 "读不到磁盘空间（$($_.Exception.Message)）—— 继续"
}

# 端口被占用不致命（可能是上一次没关干净的自己），但要说
$listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listening.Count -gt 0) {
    $ownerId = ($listening | Select-Object -First 1).OwningProcess
    $pname = (Get-Process -Id $ownerId -ErrorAction SilentlyContinue).ProcessName
    Write-Warn2 "端口 $Port 已被占用（PID $ownerId / $pname）—— 服务可能起不来"
    Write-Info '先确认那不是上一次没关干净的本服务；是的话先关掉它。'
} else {
    Write-Ok "端口 $Port 空闲"
}

# 网络：只在需要下载时才是硬要求，所以这里只探一下、不拦
$netOk = $false
try {
    $null = Invoke-WebRequest -Uri "$NodeDistBase/index.json" -Method Head -TimeoutSec 20 -UseBasicParsing
    $netOk = $true
} catch {
    try {
        $null = Invoke-WebRequest -Uri "$NodeDistBase/index.json" -TimeoutSec 20 -UseBasicParsing
        $netOk = $true
    } catch { $netOk = $false }
}
if ($netOk) { Write-Ok "能连上 $NodeDistBase" }
else { Write-Warn2 "连不上 $NodeDistBase —— 本机已有可用的 Node 就不影响启动" }

# ---------------------------------------------------------------------
# WebView2 运行时（桌面启动器的**内置浏览器**要用它）
#
# 用户：「检测环境增加一个webview，没有则自动安装 这样就行了」
#
# 它是 Edge 的 Chromium 内核运行时，Win10/11 装了 Edge 的机器基本都有；
# 没有的话，启动器里那个「打开后台」的内置浏览器窗口会初始化失败。
#
# ⚠️ 探测要**两个判据都查**，因为我自己在这里栽过一次：
#    · 注册表键名是 `pv`，**不是 `version`** —— 我第一版查 `version` 拿到空值，
#      于是把「查不到」当成了「不存在」，绕了一个大圈（详见 docs 第三十六批）；
#    · 所以主判据用**文件存在性**（msedgewebview2.exe），注册表只作补充。
#
# 自动安装走微软官方的 Evergreen Bootstrapper（约 2MB，静默安装）。
# ---------------------------------------------------------------------

function Get-WebView2Version {
    # ① 主判据：运行时本体在不在（最可靠，不依赖注册表写法）
    $roots = @()
    $pf86 = [Environment]::GetFolderPath('ProgramFilesX86')
    $pf   = [Environment]::GetFolderPath('ProgramFiles')
    if ($pf86) { $roots += (Join-Path $pf86 'Microsoft\EdgeWebView\Application') }
    if ($pf)   { $roots += (Join-Path $pf   'Microsoft\EdgeWebView\Application') }
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $dirs = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($d in $dirs) {
            if (Test-Path (Join-Path $d.FullName 'msedgewebview2.exe')) { return $d.Name }
        }
    }
    # ② 补充判据：注册表（键名是 pv）
    $keys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    foreach ($k in $keys) {
        $v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv
        if ($v) { return $v }
    }
    return $null
}

$wv2 = Get-WebView2Version
if ($wv2) {
    Write-Ok "WebView2 运行时 $wv2（启动器的内置浏览器要用）"
} else {
    Write-Warn2 'WebView2 运行时没装 —— 启动器的内置浏览器会打不开后台'
    Write-Info '正在从微软官方下载安装包（约 2MB，静默安装）…'
    $wv2Setup = Join-Path $env:TEMP 'MicrosoftEdgeWebview2Setup.exe'
    $installed = $false
    try {
        Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $wv2Setup -UseBasicParsing -TimeoutSec 180
        $sizeMB = [math]::Round((Get-Item $wv2Setup).Length / 1MB, 1)
        Write-Info "下载完成（$sizeMB MB），正在安装…"
        $p = Start-Process -FilePath $wv2Setup -ArgumentList '/silent', '/install' -Wait -PassThru
        $installed = ($p.ExitCode -eq 0)
        if (-not $installed) { Write-Warn2 "安装器返回码 $($p.ExitCode)" }
    } catch {
        Write-Warn2 "下载或安装失败：$($_.Exception.Message)"
    }
    # 装完再查一次（安装器写注册表要一小会儿）
    Start-Sleep -Seconds 2
    $wv2 = Get-WebView2Version
    if ($wv2) {
        Write-Ok "WebView2 已装好：$wv2"
    } else {
        Write-Warn2 'WebView2 仍未就绪 —— 不影响服务启动，只是启动器的内置浏览器用不了'
        Write-Info '手动装：https://developer.microsoft.com/microsoft-edge/webview2/'
        Write-Info '（或者用系统浏览器打开后台：启动器里也能看到地址）'
    }
}

# ---------------------------------------------------------------------
# ② Node：检查 → 不够就自动下载便携版
# ---------------------------------------------------------------------

Write-Head 'Node 运行时'
Write-Step "要求 >= $MinMajor.$MinMinor"

function Get-NodeInfo($exe) {
    if (-not (Test-Path $exe)) { return $null }
    try {
        $raw = (& $exe --version 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        $v = $raw.Trim().TrimStart('v')
        $p = $v.Split('.')
        return [pscustomobject]@{
            Path  = $exe
            Raw   = $v
            Major = [int]$p[0]
            Minor = if ($p.Length -gt 1) { [int]$p[1] } else { 0 }
        }
    } catch { return $null }
}

function Test-NodeOk($info) {
    if ($null -eq $info) { return $false }
    # 只比主版本不够：22.6 的 major 也是 22，但它跑不了 .ts
    return -not (($info.Major -lt $MinMajor) -or ($info.Major -eq $MinMajor -and $info.Minor -lt $MinMinor))
}

# 先看本机 PATH 上的
$sysNode = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $cmd) { $sysNode = Get-NodeInfo $cmd.Source }

# 再看便携版目录里的
$portableNode = $null
$cand = Get-ChildItem -Path $NodeDir -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $cand) { $portableNode = Get-NodeInfo $cand.FullName }

$useNode = $null
if ($ForceDownload) {
    Write-Info '-ForceDownload：强制用便携版'
    if (Test-NodeOk $portableNode) { $useNode = $portableNode }
} elseif (Test-NodeOk $sysNode) {
    $useNode = $sysNode
    Write-Ok "本机 Node v$($sysNode.Raw)"
    Write-Info $sysNode.Path
} elseif (Test-NodeOk $portableNode) {
    $useNode = $portableNode
    Write-Ok "便携版 Node v$($portableNode.Raw)"
    Write-Info $portableNode.Path
} else {
    if ($null -ne $sysNode) {
        Write-Warn2 "本机 Node v$($sysNode.Raw) 低于要求 $MinMajor.$MinMinor"
    } elseif ($null -ne $portableNode) {
        Write-Warn2 "便携版 Node v$($portableNode.Raw) 也低于要求"
    } else {
        Write-Warn2 '这台机器上没有找到 node'
    }
}

if ($null -eq $useNode) {
    if ($SkipDownload) {
        Stop-Here "缺少可用的 Node，而 -SkipDownload 让它不自动装。请手动装 >= $MinMajor.$MinMinor。"
    }
    if (-not $netOk) {
        Stop-Here "需要下载 Node，但连不上 $NodeDistBase。请检查网络，或设 DSH_NODE_MIRROR。"
    }

    Write-Step '正在自动下载便携版 Node'

    # 版本号：默认取 22.x 里最新的 LTS；拿不到清单就退回一个已知可用的
    $wantVersion = $env:DSH_NODE_VERSION
    if (-not $wantVersion) {
        try {
            $index = Invoke-RestMethod -Uri "$NodeDistBase/index.json" -TimeoutSec 60
            $pick = $index | Where-Object { $_.version -like "v$MinMajor.*" -and $_.lts -ne $false } | Select-Object -First 1
            if ($null -eq $pick) {
                $pick = $index | Where-Object { $_.version -like "v$MinMajor.*" } | Select-Object -First 1
            }
            if ($null -ne $pick) { $wantVersion = $pick.version }
        } catch {
            Write-Warn2 "取版本清单失败（$($_.Exception.Message)）—— 用兜底版本"
        }
    }
    if (-not $wantVersion) { $wantVersion = 'v22.20.0' }

    $pkgName = "node-$wantVersion-win-$arch"
    $zipUrl  = "$NodeDistBase/$wantVersion/$pkgName.zip"
    $zipPath = Join-Path $NodeDir "$pkgName.zip"

    New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null

    if (Test-Path $zipPath) {
        $mb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
        Write-Info "用已下载的缓存包（$mb MB）"
    } else {
        Write-Info "下载 $zipUrl"
        Write-Info '（约 30 MB，视网络可能要一会儿）'
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -TimeoutSec 900 -UseBasicParsing
            $sw.Stop()
            $mb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
            Write-Ok "下载完成 $mb MB，用了 $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒"
        } catch {
            Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
            Stop-Here "下载失败：$($_.Exception.Message)。可以换镜像：set DSH_NODE_MIRROR=https://npmmirror.com/mirrors/node"
        }
    }

    Write-Step '解压'
    try {
        Expand-Archive -Path $zipPath -DestinationPath $NodeDir -Force
    } catch {
        Stop-Here "解压失败：$($_.Exception.Message)"
    }
    $extracted = Get-ChildItem -Path $NodeDir -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $extracted) { Stop-Here '解压完了但找不到 node.exe，包可能损坏。删掉 .node 目录后重试。' }
    $useNode = Get-NodeInfo $extracted.FullName
    if (-not (Test-NodeOk $useNode)) { Stop-Here "装好了但版本仍不合要求：v$($useNode.Raw)" }
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Write-Ok "便携版已就绪：v$($useNode.Raw)"
    Write-Info "装在 $NodeDir（已在 .gitignore 里）"
    if ($null -ne $sysNode) {
        Write-Info "系统 PATH 上那个（v$($sysNode.Raw)）没被动过 —— 这次启动只用便携版。"
    } else {
        Write-Info '想让它全局可用，请自行安装 Node 并加进 PATH。'
    }
}

if ($useNode.Major -lt 24) {
    Write-Info "Node $($useNode.Major) 会打一条 SQLite is an experimental feature 警告 —— 正常，不影响运行。"
}

if ($CheckOnly) {
    Write-Head '只做检查（-CheckOnly）'
    Write-Ok "Node v$($useNode.Raw) 可用"
    Read-Host '按回车退出'
    exit 0
}

# npm 跟着选中的那份 Node 走：便携版目录里有 npm.cmd
$nodeExeDir = Split-Path $useNode.Path -Parent
$npmCmd = Join-Path $nodeExeDir 'npm.cmd'
if (-not (Test-Path $npmCmd)) {
    $npmOnPath = Get-Command npm -ErrorAction SilentlyContinue
    if ($null -eq $npmOnPath) { Stop-Here '找不到 npm —— Node 装得不完整。' }
    $npmCmd = $npmOnPath.Source
}

# ---------------------------------------------------------------------
# ③ 依赖
# ---------------------------------------------------------------------

Write-Head '依赖'
if (Test-Path (Join-Path $Root 'node_modules')) {
    Write-Ok 'node_modules 已存在'
} else {
    Write-Step '安装依赖（首次需要一会儿）'
    $npmArgs = @()
    if (Test-Path (Join-Path $Root 'package-lock.json')) {
        $npmArgs += 'ci'
        Write-Info '用 npm ci（按 package-lock.json 的锁定版本装）'
    } else {
        $npmArgs += 'install'
        Write-Info '用 npm install（没有 package-lock.json）'
    }
    if ($NpmRegistry) {
        $npmArgs += @('--registry', $NpmRegistry)
        Write-Info "registry：$NpmRegistry"
    }
    & $npmCmd @npmArgs
    if ($LASTEXITCODE -ne 0 -and -not $NpmRegistry) {
        Write-Warn2 '安装失败，用国内镜像再试一次'
        & $npmCmd @npmArgs --registry 'https://registry.npmmirror.com'
    }
    if ($LASTEXITCODE -ne 0) {
        Stop-Here '依赖安装失败。可以先手动跑一次 npm ci 看详细报错。'
    }
    Write-Ok '依赖已装好'
}

# ---------------------------------------------------------------------
# ④ 配置
# ---------------------------------------------------------------------

Write-Head '配置'
$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) {
    Write-Ok '.env 已存在'
    $portLine = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $portLine) { $Port = [int]$portLine.Matches[0].Groups[1].Value }
    $pwLine = Select-String -Path $envFile -Pattern '^\s*ADMIN_PASSWORD\s*=\s*(\S+)' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $pwLine) {
        Write-Warn2 'ADMIN_PASSWORD 没设 —— 启动日志里会给一个临时口令（重启会换）'
    }
} else {
    if (Test-Path (Join-Path $Root '.env.example')) {
        Copy-Item (Join-Path $Root '.env.example') $envFile
        Write-Warn2 '没有 .env，已从 .env.example 复制一份'
        Write-Info '要连真实 QQ 通道，请先编辑 .env 填 AppID / Secret；'
        Write-Info '只想起来看看后台，现在这样就能跑。'
    } else {
        Write-Warn2 '没有 .env 也没有 .env.example —— 服务会用默认配置启动'
    }
}

# ---------------------------------------------------------------------
# ⑤ 启动
# ---------------------------------------------------------------------

Write-Head '正在启动服务'
Write-Host "  管理后台：http://127.0.0.1:$Port/admin" -ForegroundColor White
Write-Host '  （口令在 .env 的 ADMIN_PASSWORD）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  停止服务：在这个窗口按 Ctrl+C' -ForegroundColor DarkGray
Write-Host ''

# 用选中的那份 node 起服务（而不是依赖 PATH —— 便携版可能不在 PATH 上）
$mainTs = Join-Path $Root 'src\main.ts'
if (-not (Test-Path $mainTs)) { Stop-Here "找不到 $mainTs —— 这个脚本要放在仓库根目录。" }

& $useNode.Path $mainTs
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host ''
    Write-Err "服务退出，退出码 $code"
    Write-Info '常见原因：端口被占用、.env 配置有误、数据库被另一个进程锁着。'
    Write-Info '详细报错就在上面。'
}
Read-Host '按回车关闭这个窗口'
