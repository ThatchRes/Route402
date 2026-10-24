param(
  [ValidateSet('', 'payout', 'router', 'workers', 'gateway', 'ask')][string]$Service = '',
  [string]$Text = '',
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$localWorkspace = Join-Path $projectRoot 'payout-sim\data\local-workspace'

function Read-Env([string]$file) {
  $values = @{}
  if (Test-Path -LiteralPath $file) {
    foreach ($line in Get-Content -LiteralPath $file) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $values[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'") }
    }
  }
  return $values
}

if (!$Service) {
  foreach ($port in @(8403, 8404, 8100, 8101)) {
    $client = [Net.Sockets.TcpClient]::new()
    try { $client.Connect('127.0.0.1', $port); throw "Port $port is already in use. Stop the existing demo before starting the isolated local run." }
    catch [Net.Sockets.SocketException] {} finally { $client.Dispose() }
  }
  $localData = Join-Path $localWorkspace 'data'
  New-Item -ItemType Directory -Force -Path $localData | Out-Null
  $linkedSnapshot = Join-Path $projectRoot 'payout-sim\data\linked.json'
  $localLinked = Join-Path $localData 'linked.json'
  if ((Test-Path -LiteralPath $linkedSnapshot) -and !(Test-Path -LiteralPath $localLinked)) { Copy-Item -LiteralPath $linkedSnapshot -Destination $localLinked }
  foreach ($name in @('payout', 'router', 'workers', 'gateway')) {
    Start-Process powershell -WindowStyle Hidden -WorkingDirectory $projectRoot -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Service', $name
    ) -RedirectStandardOutput (Join-Path $localWorkspace "$name.log") -RedirectStandardError (Join-Path $localWorkspace "$name.error.log") | Out-Null
  }
  Write-Output 'Starting LOCAL simulation: payout server, router, workers, gateway.'
  Write-Output 'Open http://localhost:8404/app/#/chat after the services finish starting.'
  Write-Output "Separate data and logs: $localWorkspace"
  Write-Output 'No x402 payments, testnet settlement, or automatic bank writeback. Stop with .\stop-demo.ps1'
  return
}

$routerEnv = Read-Env (Join-Path $projectRoot 'payout-sim\.env')
$serviceEnv = if ($Service -in @('workers', 'gateway')) { Read-Env (Join-Path $projectRoot 'services\agents\.env') } else { $routerEnv }
foreach ($key in $serviceEnv.Keys) { Set-Item -LiteralPath "Env:$key" -Value $serviceEnv[$key] }
$env:ROUTER_TOKEN = if ($routerEnv['ROUTER_TOKEN']) { $routerEnv['ROUTER_TOKEN'] } else { 'dev-token' }
$env:AGENT_SERVICE_TOKEN = $env:ROUTER_TOKEN
$env:LOCAL_ROUTING = '1'; $env:LIVE_MARKET = '0'; $env:MOCK_API = '0'; $env:ENABLE_CHAT = '0'
$env:API_BASE_URL = 'http://127.0.0.1:8404'; $env:PAYOUT_URL = 'http://127.0.0.1:8403'
$env:AGENT_GATEWAY_URL = 'http://127.0.0.1:8100'; $env:ROUTER_PORT = '8404'
$env:GATEWAY_PORT = '8100'; $env:WORKERS_PORT = '8101'; $env:PORT = '8403'
$env:EVIDENCE_API_BASE_URL = ''; $env:ALLOWED_TENANTS = 'demo-tenant'; $env:AGENT_TENANT = 'demo-tenant'
$env:ANTHROPIC_API_KEY = ''; $env:LLM_MODEL = ''
$env:AGENT_METRICS_FILE = Join-Path $localWorkspace 'metrics.json'
if (!(Test-Path -LiteralPath $localWorkspace)) { throw 'Run .\start-local.ps1 first to create the local workspace.' }
Set-Location -LiteralPath $localWorkspace
if ($Service -in @('workers', 'gateway')) {
  & (Join-Path $projectRoot 'services\agents\.venv\Scripts\python.exe') (Join-Path $projectRoot "services\agents\$Service.py")
} else {
  $source = switch ($Service) { 'payout' { 'src\server.ts' }; 'router' { 'src\router\server.ts' }; 'ask' { 'src\assistant\cli.ts' } }
  $cliArgs = if ($Service -eq 'ask') { if (!$Text) { throw 'Supply -Text with your request.' }; @($Text) + $(if ($Execute) { @('--execute') } else { @() }) } else { @() }
  & node (Join-Path $projectRoot 'payout-sim\node_modules\tsx\dist\cli.mjs') (Join-Path $projectRoot "payout-sim\$source") @cliArgs
}
exit $LASTEXITCODE
