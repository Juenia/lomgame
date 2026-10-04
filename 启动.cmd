@echo off
REM =====================================================================
REM 一键启动（cmd 入口）—— 只是把 启动.ps1 包一层。
REM
REM 为什么不直接用 npm start：
REM   项目要求 Node >= 22.18，而「没装 node / 版本太低」这类问题的报错
REM   在 npm 那里是一串栈，在这里是一句中文，而且**它会自己装**。
REM =====================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动.ps1" %*
    goto :end
)

where powershell >nul 2>nul
if %errorlevel%==0 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动.ps1" %*
    goto :end
)

echo.
echo   [错误] 找不到 PowerShell（pwsh 或 powershell）。
echo          请手动执行：npm start
echo.
pause

:end
endlocal
