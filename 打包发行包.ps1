# =====================================================================
# 打包发行包 —— 入口脚本（真正的清单在 build\打包发行包.mjs）
#
# 用法：powershell -ExecutionPolicy Bypass -File 打包发行包.ps1
# 产物：dist\诡秘之主-群星低语-<日期>.zip
#
# ## 为什么这里只有一行调用
#
# 这个脚本原来自己用 PowerShell 复制文件 + Compress-Archive 打包，
# 而那份「要带什么 / 不带什么」的清单**与 Node 版是两份**。
# 两份清单迟早会漂移，而漂移的表现是「用这个脚本打的包多了或少了一样东西」——
# 不报错，只有解压出来才发现。
#
# 所以现在只留一份实现（`build\打包发行包.mjs`，那里有完整的排除理由），
# 这个脚本负责：找 Node → 跑它 → 报错时把话说明白。
#
# ## 排除清单（详见 build\打包发行包.mjs 的文件头）
#
#   敏感   .env · data/ 里除 artwork 与 game.db 的全部（备份 / 测试库 / 会话 token / 日志）
#   文档   docs/ · README.md · AGENTS.md · 原始设计方案.MD · 开发流程文档/
#          · 诡秘之主原作数据/（原文素材，版权敏感）· test/
#   开发用 .git/ · m220-baseline/ · viz/ · scripts/ · backups/ · 各种临时目录
#   垃圾   *.bak · *.log · *.tmp · Thumbs.db · .DS_Store
#   多余   node_modules 里的 devDependencies（typescript / @types）
# =====================================================================

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$Node = $null
foreach ($candidate in @('node', (Join-Path $PSScriptRoot '.node\node.exe'))) {
    try {
        $version = & $candidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $version) { $Node = $candidate; break }
    } catch { }
}

if (-not $Node) {
    Write-Host ''
    Write-Host '找不到 Node.js —— 打包需要它（只有打包需要，玩游戏不需要）。' -ForegroundColor Red
    Write-Host '装一个：https://nodejs.org/  或者先跑一次 启动.ps1（它会自动下载一份便携版到 .node\）'
    exit 1
}

& $Node (Join-Path $PSScriptRoot 'build\打包发行包.mjs')
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '打包失败 —— 上面的输出里有原因。' -ForegroundColor Red
    exit $LASTEXITCODE
}

