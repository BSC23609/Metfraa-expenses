@echo off
REM ====================================================================
REM  push.bat  -  Push the Metfraa Expense Portal to GitHub
REM  Repo: https://github.com/BSC23609/Metfraa-expenses
REM
REM  Handles BOTH:
REM    - First run  : initialises git, sets the remote, first commit/push
REM    - Later runs : add + commit + push your latest changes
REM
REM  Safety: refuses to push if a real .env file is being tracked,
REM  so your Google / Azure secrets never end up on GitHub.
REM ====================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

set REMOTE_URL=https://github.com/BSC23609/Metfraa-expenses.git
set BRANCH=main

echo.
echo ====================================================
echo   Metfraa Expense Portal  -  Push to GitHub
echo ====================================================
echo.

REM --- 0. Is git installed? -------------------------------------------
git --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git is not installed or not on your PATH.
  echo         Install it from https://git-scm.com/download/win then re-run.
  goto :end
)

REM --- 1. First-time init if needed -----------------------------------
if not exist ".git" (
  echo [setup] No git repo here yet. Initialising...
  git init
  git branch -M %BRANCH%
  git remote add origin %REMOTE_URL%
  echo [setup] Remote set to %REMOTE_URL%
  echo.
) else (
  REM make sure the remote is correct / present
  git remote get-url origin >nul 2>&1
  if errorlevel 1 (
    echo [setup] Adding missing 'origin' remote...
    git remote add origin %REMOTE_URL%
  )
)

REM --- 2. SAFETY: never commit a real .env ----------------------------
REM If .env is currently tracked, stop and tell the user.
git ls-files --error-unmatch .env >nul 2>&1
if not errorlevel 1 (
  echo.
  echo [STOP] Your .env file is being tracked by git!
  echo        That file holds your Google/Azure secrets and must NOT
  echo        go to GitHub. Removing it from tracking now ^(your local
  echo        copy is kept^):
  git rm --cached .env
  echo        Done. It is in .gitignore, so it will stay out from now on.
  echo.
)

REM --- 3. Show what will be committed ---------------------------------
echo [status] Changes to be pushed:
git status --short
echo.

REM --- 4. Commit message ----------------------------------------------
set "MSG=%~1"
if "%MSG%"=="" (
  set /p MSG="Commit message (press Enter for a timestamped default): "
)
if "%MSG%"=="" (
  for /f "tokens=1-5 delims=/:. " %%a in ("%date% %time%") do set MSG=Update %%a-%%b-%%c %%d:%%e
)

REM --- 5. Add, commit, push -------------------------------------------
git add -A

REM commit only if there is something staged
git diff --cached --quiet
if not errorlevel 1 (
  echo [info] Nothing new to commit. Pushing existing commits anyway...
) else (
  git commit -m "!MSG!"
)

echo.
echo [push] Pushing to %REMOTE_URL% ^(branch %BRANCH%^)...
git push -u origin %BRANCH%
if errorlevel 1 (
  echo.
  echo [ERROR] Push failed. Common causes:
  echo   - First push: GitHub will ask you to sign in ^(a browser window
  echo     or a Personal Access Token^). Follow the prompt and re-run.
  echo   - The repo already has commits: try  git pull --rebase  first,
  echo     then run push.bat again.
  goto :end
)

echo.
echo [DONE] Pushed successfully.
echo        Render will auto-deploy if it is connected to this repo.

:end
echo.
pause
endlocal
