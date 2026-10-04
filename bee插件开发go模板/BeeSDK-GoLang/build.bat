@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
chcp 936 >nul

echo ========================================
echo Bee Go 插件构建工具
echo ========================================
echo.

where go >nul 2>nul || goto :missing_go
where zig >nul 2>nul || goto :missing_zig

if exist temp rmdir /s /q temp
mkdir temp || goto :fail
if not exist build mkdir build || goto :fail

echo [1/4] 正在生成插件元数据...
go run .\other\buildmeta plugin_main.go temp > temp\plugin_name.txt
if errorlevel 1 goto :fail
set /p "PLUGIN_NAME=" < temp\plugin_name.txt
if not defined PLUGIN_NAME goto :metadata_empty
del /q temp\plugin_name.txt >nul 2>nul

set "DLL_NAME=%~1"
if not defined DLL_NAME set "DLL_NAME=%PLUGIN_NAME%"
if /i "%DLL_NAME:~-4%"==".dll" set "DLL_NAME=%DLL_NAME:~0,-4%"
if not defined DLL_NAME goto :invalid_name

echo [2/4] 正在编译 Windows 32 位 Go 工作进程...
set GOOS=windows
set GOARCH=386
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -ldflags="-s -w" -o temp\bee_go_worker.exe .
set "BUILD_RESULT=%ERRORLEVEL%"
del /q worker_runtime.go >nul 2>nul
if not "%BUILD_RESULT%"=="0" goto :fail

echo [3/4] 正在编译内嵌工作进程资源...
pushd temp
zig rc /c 65001 /fo worker.res worker.rc
if errorlevel 1 (popd & goto :fail)
popd

echo [4/4] 正在链接纯 C PE32 插件 DLL...
zig cc -target x86-windows-gnu -O2 -shared other\bee_bridge.c temp\worker.res other\BeePlugin.def -Itemp -lkernel32 -o "build\%DLL_NAME%.dll" || goto :fail

del /q build\*.lib build\*.pdb >nul 2>nul
rmdir /s /q temp
echo.
echo 构建成功：build\%DLL_NAME%.dll
pause
exit /b 0

:missing_go
echo 错误：未在 PATH 环境变量中找到 Go。
echo 请从官方网站下载安装：https://go.dev/dl/
goto :error_exit

:missing_zig
echo 错误：未在 PATH 环境变量中找到 Zig。
echo 请从官方网站下载安装：https://ziglang.org/download/
goto :error_exit

:metadata_empty
echo 错误：插件元数据生成器返回的插件名称为空。
goto :fail

:invalid_name
echo 错误：DLL 文件名无效。
goto :fail

:fail
if exist worker_runtime.go del /q worker_runtime.go >nul 2>nul
if exist temp rmdir /s /q temp
echo 错误：构建失败，请检查上方的错误信息。

:error_exit
echo.
pause
exit /b 1
