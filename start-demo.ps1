$root = "C:\Users\tlres\OneDrive\Desktop\Apps\Calhacks"
function Open($title, $dir, $cmd) {
  Start-Process powershell -WorkingDirectory "$root\$dir" -ArgumentList "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='$title'; $cmd"
  Start-Sleep 2
}
function OpenAgent($file) {
  Start-Process powershell -WorkingDirectory "$root\services\agents" -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "run-agent.ps1", $file
  Start-Sleep 2
}
Open "payout server" "payout-sim" "npm run server"
Open "router"        "payout-sim" "npm run router"
Open "x402 seller"   "x402-spike" "npm run seller"
Open "providers"     "x402-spike" "npm run providers"
Open "agent wallet"  "x402-spike" "Start-Sleep 15; npm run wallet"
OpenAgent "workers.py"
Start-Sleep 5
OpenAgent "gateway.py"
