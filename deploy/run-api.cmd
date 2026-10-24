@echo off
rem Launched by scheduled task ambition-api (SYSTEM). Installed to D:\ambition\bin\run-api.cmd by deploy\setup-api.ps1.
rem The API key is NOT set here: the server reads D:\ambition\secrets\api.env itself.
set PATH=D:\ambition\bin\node;%PATH%
set AMBITION_DATA_DIR=D:\ambition\data
set AMBITION_MEDIA_DIR=D:\ambition\media
cd /d D:\ambition\repo\server
node src\index.mjs >> D:\ambition\logs\api.log 2>&1
