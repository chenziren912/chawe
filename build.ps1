$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
New-Item -ItemType Directory -Force 'build/classes' | Out-Null
$chaweSources = @(Get-ChildItem -LiteralPath 'src/chawe' -Filter '*.java' | ForEach-Object FullName)
& javac --release 17 -encoding UTF-8 -d 'build/classes' $chaweSources
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed' }
& jar --create --file 'build/chawe.jar' --main-class chawe.Main -C 'build/classes' .
if ($LASTEXITCODE -ne 0) { throw 'JAR creation failed' }
Write-Output 'Built build/chawe.jar'
