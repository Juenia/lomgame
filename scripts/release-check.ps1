# =====================================================================
# Pre-release self check  (scripts/release-check.ps1)
#
# Run from the repo root:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-check.ps1
#
# Report only, never modifies anything. Six checks, each one is a way a
# release embarrasses itself:
#   1 absolute paths   hardcoded machine paths -> breaks on another box
#   2 secrets          .env committed -> keys travel with the source
#   3 ignored dirs     .node / node_modules / data not ignored -> huge zip
#   4 node floor       launcher and package.json must agree
#   5 artifacts        launcher present, parses, UTF-8 with BOM
#   6 smoke            typecheck + full test suite
#
# Exit code: 0 = shippable, 1 = blockers.
#
# Output is intentionally ASCII-only: Chinese text in this file once tripped a
# PowerShell 5.1 parse failure that cost a lot of time. A release gate nobody
# can read is worse than an English one.
# =====================================================================

[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Set-Location -Path (Split-Path $PSScriptRoot -Parent)
$Root = (Get-Location).Path
$blockers = 0

function Say($text) { if (-not $Quiet) { Write-Host $text } }
function Ok($text)  { Say ('  OK    ' + $text) }
function Bad($text) { Write-Host ('  BLOCK ' + $text) -ForegroundColor Red; $script:blockers = $script:blockers + 1 }
function Note($text){ Say ('  note  ' + $text) }

Say 'LORD OF MYSTERIES -- pre-release check'

Say '1 absolute paths'
$bs = [char]92
$pats = @()
$pats += ('C:' + $bs + 'Users' + $bs)
$pats += ('C:' + $bs + 'Program Files')
$pats += '/home/'
$dirs = @('src', 'scripts', 'test')
$exts = @('.ts', '.js', '.mjs', '.ps1', '.cmd', '.json', '.yaml', '.sql')
$found = @()
foreach ($d in $dirs) {
    $p = Join-Path $Root $d
    if (-not (Test-Path $p)) { continue }
    foreach ($f in (Get-ChildItem -Path $p -Recurse -File -ErrorAction SilentlyContinue)) {
        if ($exts -notcontains $f.Extension) { continue }
        if ($f.Name -eq 'release-check.ps1') { continue }
        $hit = Select-String -Path $f.FullName -Pattern $pats -SimpleMatch -ErrorAction SilentlyContinue
        if ($null -ne $hit) { $found += ($f.FullName + ' line ' + $hit.LineNumber) }
    }
}
if ($found.Count -eq 0) { Ok 'no hardcoded machine paths' }
else { foreach ($x in $found) { Bad ('absolute path: ' + $x) } }

Say '2 secrets'
$tracked = @(git ls-files 2>$null)
if ($tracked.Count -eq 0) { Note 'not a git repo, skipped' }
else {
    $leak = @()
    foreach ($t in $tracked) {
        if ($t -eq '.env') { $leak += $t }
        if ($t -like 'backups/*') { $leak += $t }
        if ($t -like '*.db') { $leak += $t }
    }
    if ($leak.Count -eq 0) { Ok '.env / backups / *.db are not tracked' }
    else { foreach ($x in $leak) { Bad ('tracked secret file: ' + $x) } }
    if ($tracked -contains '.env.example') { Ok '.env.example is tracked' }
    else { Bad '.env.example is missing from git' }
}

Say '3 ignored dirs'
$mustIgnore = @('.node', 'node_modules', 'data', 'backups', 'm220-baseline', '.harness-tmp')
foreach ($d in $mustIgnore) {
    if (-not (Test-Path $d)) { continue }
    git check-ignore -q $d 2>$null
    if ($LASTEXITCODE -eq 0) { Ok ($d + ' is ignored') }
    else { Bad ($d + ' is NOT ignored') }
}

# ---- locate the launcher ----
# NOTE: the launcher filename is Chinese. This file is UTF-8 **without** a BOM,
# and PowerShell 5.1 reads BOM-less files as ANSI -- so a literal non-ASCII
# filename in here turns into mojibake and Get-Content cannot find the file.
# That was the real cause of several confusing failures earlier. So: find it
# by shape, never spell it.
$launcher = ''
$launcherCmd = ''
foreach ($f in (Get-ChildItem -Path $Root -File -ErrorAction SilentlyContinue)) {
    if ($f.Name -eq 'release-check.ps1') { continue }
    if ($f.Extension -eq '.ps1') { $launcher = $f.Name }
    if ($f.Extension -eq '.cmd') { $launcherCmd = $f.Name }
}
if ($launcher -eq '') { Bad 'no launcher (.ps1) found in repo root' }
else { Ok ('launcher found: ' + $launcher) }

Say '4 node floor'
$pkgMajor = -1
$pkgMinor = -1
$psMajor = -1
$psMinor = -1

# 用正则一次抓出 >=a.b。
# 之前用过 [int]::TryParse 配 [ref]，那条路在 PowerShell 5.1 下不可靠：
# 解析失败时它会把变量写成 0（而不是保留初值），于是比较变成「22.18 vs 0.0」，
# 报出来的却是一句看不出根因的 mismatch。正则没有这个坑。
$verPat = '>=' + '([0-9]+)' + [char]92 + '.' + '([0-9]+)'

# package.json：engines.node 那一行
foreach ($ln in (Get-Content 'package.json')) {
    if ($ln -notlike '*node*') { continue }
    $m = [regex]::Match($ln, $verPat)
    if (-not $m.Success) { continue }
    $pkgMajor = [int]$m.Groups[1].Value
    $pkgMinor = [int]$m.Groups[2].Value
    break
}

# launcher：把 MinMajor / MinMinor 的赋值行挑出来。
#
# 两个坑都在这里踩过，注释留下免得下次重犯：
#   1. 用普通 -like 会连**注释行**一起匹配（注释里写的就是 MinMajor 这几个字），
#      而注释里第一个数字不是版本号 -> 曾读出 1.2。用 -clike（大小写敏感）
#      精确匹配 ' = ' 那种赋值形状。
#   2. 匹配到之后必须 break：$MinMajor 在文件里出现 5 次以上
#      （赋值 1 次、字符串插值 4 次），不 break 的话后面那些行会把值覆盖掉。
foreach ($ln in (Get-Content $launcher)) {
    if (($psMajor -lt 0) -and ($ln -clike '*$MinMajor = *')) {
        $m2 = [regex]::Match($ln, '= *([0-9]+)')
        if ($m2.Success) { $psMajor = [int]$m2.Groups[1].Value }
    }
    if (($psMinor -lt 0) -and ($ln -clike '*$MinMinor = *')) {
        $m3 = [regex]::Match($ln, '= *([0-9]+)')
        if ($m3.Success) { $psMinor = [int]$m3.Groups[1].Value }
    }
}

if ($pkgMajor -lt 0) { Bad 'cannot read engines.node from package.json' }
elseif ($psMajor -lt 0) { Bad 'cannot read MinMajor from the launcher' }
elseif (($pkgMajor -eq $psMajor) -and ($pkgMinor -eq $psMinor)) {
    Ok ('both say >= ' + $pkgMajor + '.' + $pkgMinor)
}
else {
    Bad ('mismatch: package.json >= ' + $pkgMajor + '.' + $pkgMinor + ' but launcher >= ' + $psMajor + '.' + $psMinor)
}
Say '5 artifacts'
$mustHave = @($launcher, $launcherCmd, 'README.md', '.env.example', 'package.json')
foreach ($f in $mustHave) {
    if (Test-Path $f) { Ok ($f + ' present') }
    else { Bad ('missing ' + $f) }
}
if (($launcher -ne '') -and (Test-Path $launcher)) {
    $p = (Resolve-Path $launcher).Path
    $b = [System.IO.File]::ReadAllBytes($p)
    if (($b.Length -ge 3) -and ($b[0] -eq 239) -and ($b[1] -eq 187) -and ($b[2] -eq 191)) { Ok 'launcher is UTF-8 with BOM' }
    else { Bad 'launcher has no BOM' }
    $perr = $null
    [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$perr) | Out-Null
    if ($perr.Count -eq 0) { Ok 'launcher parses' }
    else { Bad ('launcher parse error: ' + $perr[0].Message) }
}

Say '6 smoke'
if ($SkipTests) { Note 'typecheck and tests skipped' }
else {
    Say '  running typecheck...'
    $null = & npx tsc --noEmit 2>&1
    if ($LASTEXITCODE -eq 0) { Ok 'typecheck passed' }
    else { Bad 'typecheck failed' }
    Say '  running full test suite (about a minute)...'
    $out = (& npm test 2>&1 | Out-String)
    # node --test 的汇总行长这样（前面有 unicode 符号）：
    #   ℹ pass 1148        （新版本）
    #   # pass 1148        （旧版本）
    # 所以用正则找「pass 数字 / fail 数字」，而不是按行首匹配 ——
    # 按行首匹配会在带前缀的那一版上静默读到 0，然后报「测试没过」。
    $pN = 0
    $fN = 0
    $mPass = [regex]::Match($out, 'pass ([0-9]+)')
    if ($mPass.Success) { $pN = [int]$mPass.Groups[1].Value }
    $mFail = [regex]::Match($out, 'fail ([0-9]+)')
    if ($mFail.Success) { $fN = [int]$mFail.Groups[1].Value }
    if (($fN -eq 0) -and ($pN -gt 0)) { Ok ('tests passed: ' + $pN) }
    else { Bad ('tests: pass=' + $pN + ' fail=' + $fN) }
}

Write-Host '------------------------------------------------------------'
if ($blockers -eq 0) {
    Write-Host '  SHIPPABLE: no blockers' -ForegroundColor Green
    exit 0
}
Write-Host ('  NOT SHIPPABLE: ' + $blockers + ' blocker(s)') -ForegroundColor Red
exit 1