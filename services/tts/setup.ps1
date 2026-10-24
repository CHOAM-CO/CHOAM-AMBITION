$ErrorActionPreference='Stop'
$d='D:\ambition\tts'
New-Item -ItemType Directory -Force -Path $d | Out-Null
$f="$d\pocket-tts-ko-100m-int8.onnx"
$url='https://github.com/CHOAM-CO/scheherazade-releases/releases/download/models-v1/pocket-tts-ko-100m-int8.onnx'
$want='d944f9bb99f2aed1207e7ab359fc740716de647196ce23af14d76b40490e880d'
if (-not (Test-Path $f) -or (Get-Item $f).Length -ne 226210253) {
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  $ProgressPreference='SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile "$f.part" -UseBasicParsing
  Move-Item "$f.part" $f -Force
}
$got=(Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
"size=$((Get-Item $f).Length) sha256=$got match=$($got -eq $want)"
if ($got -ne $want) { throw 'sha mismatch' }
if (-not (Test-Path "$d\node_modules\onnxruntime-node")) {
  $env:Path="D:\ambition\bin\node;$env:Path"
  $env:npm_config_cache='D:\ambition\npm-cache'
  Push-Location $d
  if (-not (Test-Path package.json)) { Set-Content package.json '{"name":"ambition-tts-deps","private":true}' -Encoding ascii }
  & D:\ambition\bin\node\npm.cmd install onnxruntime-node@1.30.0 --no-audit --no-fund 2>&1 | Out-String
  Pop-Location
}
Get-ChildItem "$d\node_modules\onnxruntime-node\bin\napi-v6\win32" -Recurse | Select -First 8 FullName
