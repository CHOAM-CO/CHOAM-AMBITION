@echo off
set CUDA_VISIBLE_DEVICES=0
set HF_HOME=D:\ambition\asr\hf
set TEMP=D:\ambition\asr\tmp
set TMP=D:\ambition\asr\tmp
set PYTHONUNBUFFERED=1
set PYTHONUTF8=1
D:\ambition\asr\venv\Scripts\python.exe D:\ambition\asr\server.py >> D:\ambition\asr\logs\asr.log 2>&1
