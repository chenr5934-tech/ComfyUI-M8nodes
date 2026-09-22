@echo off
chcp 65001 >nul
title M8 工作台

set PORT=8199
set HERE=%~dp0

rem 已经在跑就不再起第二个（两个服务同时写同一份文件会互相盖）
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if %errorlevel%==0 goto open

rem 找 python。不写死任何位置 —— 各家 ComfyUI 装法不一样。
rem 最靠得住的一招是从路标文件反推：那个文件是 ComfyUI 加载插件时写的，
rem 内容是数据目录（<ComfyUI>\models\M8data）。从它往上两级就是 ComfyUI 根，
rem 便携版的 python 在 ComfyUI 的上一级。

set PY=
set DATADIR=
set CUIROOT=

if exist "%HERE%.m8data" for /f "usebackq delims=" %%L in ("%HERE%.m8data") do set DATADIR=%%L
if defined DATADIR for %%D in ("%DATADIR%\..\..") do set CUIROOT=%%~fD

rem 便携版：整合包根\python\python.exe（ComfyUI 的上一级）
if not defined PY if defined CUIROOT if exist "%CUIROOT%\..\python\python.exe" set PY=%CUIROOT%\..\python\python.exe
if not defined PY if defined CUIROOT if exist "%CUIROOT%\python\python.exe" set PY=%CUIROOT%\python\python.exe
if not defined PY if defined CUIROOT if exist "%CUIROOT%\..\venv\Scripts\python.exe" set PY=%CUIROOT%\..\venv\Scripts\python.exe
if not defined PY if defined CUIROOT if exist "%CUIROOT%\..\.venv\Scripts\python.exe" set PY=%CUIROOT%\..\.venv\Scripts\python.exe

rem 还没找到就问问脚本自己周围（插件没走 junction 的装法）
if not defined PY if exist "%HERE%..\..\..\..\python\python.exe" set PY=%HERE%..\..\..\..\python\python.exe
if not defined PY if exist "%HERE%..\..\..\python\python.exe" set PY=%HERE%..\..\..\python\python.exe
if not defined PY if exist "%HERE%..\..\python\python.exe" set PY=%HERE%..\..\python\python.exe

rem 最后问 PATH
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py

if not defined PY goto nopy

start "M8 工作台服务" /min "%PY%" "%HERE%m8-serve.py" %PORT%
timeout /t 3 /nobreak >nul

:open
start "" "http://127.0.0.1:%PORT%/m8/web/index.html"
exit /b 0

:nopy
echo.
echo   找不到 python。
echo   便携版 ComfyUI 自带一个，一般在整合包根目录的 python\python.exe。
echo   这个脚本靠 "%HERE%.m8data" 这个路标去认 ComfyUI 在哪 ——
echo   那个文件是 ComfyUI 加载插件时写的，现在还没有。
echo.
echo   两个办法：
echo     1) 先启动一次 ComfyUI，让它把路标写出来，再来双击这个脚本；
echo     2) 或者设一个环境变量 M8_DATA_DIR 指向你想放数据的地方。
echo.
pause
exit /b 1
