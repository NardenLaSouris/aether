@echo off
rem Construit puis lance la version de production locale (sans installateur).
cd /d "%~dp0\.."
if not exist node_modules call npx -y pnpm@10 install || exit /b 1
call npx -y pnpm@10 build || exit /b 1
call npx -y pnpm@10 start
