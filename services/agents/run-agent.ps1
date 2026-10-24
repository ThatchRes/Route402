param([string]$script)
Set-Location $PSScriptRoot
Get-Content .env | Where-Object { $_ -match "^\s*[^#].*=" } | ForEach-Object {
  $k, $v = $_ -split "=", 2; Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim() }
$env:ENABLE_CHAT = "1"
$host.UI.RawUI.WindowTitle = $script
& "$PSScriptRoot\.venv\Scripts\python.exe" $script
