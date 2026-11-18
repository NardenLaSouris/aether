@echo off
rem Lance Aether en mode developpement (rechargement a chaud).
cd /d "%~dp0\.."
if not exist node_modules (
  echo Installation des dependances...
  call npx -y pnpm@10 install || exit /b 1
)
call npx -y pnpm@10 dev
