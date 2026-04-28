@echo off
chcp 65001 > nul
cd /d "%~dp0"

:: Node.js 경로 자동 탐색
set NODE_EXE=
set NPM_CMD=

if exist "%ProgramFiles%\nodejs\node.exe" (
    set NODE_EXE="%ProgramFiles%\nodejs\node.exe"
    set NPM_CMD="%ProgramFiles%\nodejs\npm.cmd"
    goto :found
)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set NODE_EXE="%ProgramFiles(x86)%\nodejs\node.exe"
    set NPM_CMD="%ProgramFiles(x86)%\nodejs\npm.cmd"
    goto :found
)
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set NODE_EXE="%LOCALAPPDATA%\Programs\nodejs\node.exe"
    set NPM_CMD="%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
    goto :found
)

:: PATH에서도 찾아보기
where node >nul 2>&1
if %errorlevel% equ 0 (
    set NODE_EXE=node
    set NPM_CMD=npm
    goto :found
)

echo [오류] Node.js를 찾을 수 없습니다.
echo https://nodejs.org 에서 LTS 버전을 설치해주세요.
echo 설치 후 PC를 재시작하거나 이 파일을 다시 실행해주세요.
pause
exit /b 1

:found
echo Node.js 확인: %NODE_EXE%

if not exist "node_modules" (
    echo.
    echo [안내] 처음 실행입니다. 패키지를 설치합니다. 잠시 기다려주세요...
    echo.
    %NPM_CMD% install
    if %errorlevel% neq 0 (
        echo.
        echo [오류] 패키지 설치에 실패했습니다.
        pause
        exit /b 1
    )
)

%NPM_CMD% start
