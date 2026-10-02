@echo off
chcp 65001 >nul
rem Dual-layer file/folder encryptor. Usage: pkv enc|dec|list|verify ...
node "%~dp0vault.ts" %*
