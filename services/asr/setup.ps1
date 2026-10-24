$ErrorActionPreference = 'Continue'
$R = 'D:\ambition\asr'
New-Item -ItemType Directory -Force -Path $R, "$R\logs", "$R\uv-cache", "$R\uv-python", "$R\hf", "$R\tmp" | Out-Null
$env:UV_CACHE_DIR = "$R\uv-cache"
$env:UV_PYTHON_INSTALL_DIR = "$R\uv-python"
$env:UV_PYTHON_BIN_DIR = "$R\uv-pybin"
$env:HF_HOME = "$R\hf"
$env:TEMP = "$R\tmp"; $env:TMP = "$R\tmp"
$uv = 'C:\Users\jho63\.local\bin\uv.exe'
& $uv venv "$R\venv" --python 3.12 --managed-python
& $uv pip install --python "$R\venv\Scripts\python.exe" torch torchaudio --index-url https://download.pytorch.org/whl/cu128
& $uv pip install --python "$R\venv\Scripts\python.exe" qwen-asr
& "$R\venv\Scripts\python.exe" -c "import torch,transformers,qwen_asr;print('torch',torch.__version__,torch.cuda.is_available(),transformers.__version__)"
& $uv pip list --python "$R\venv\Scripts\python.exe" | Select-String -Pattern 'torch|transformers|qwen|accelerate|numpy|librosa|flask|soundfile'
Write-Output 'SETUP_DONE'
