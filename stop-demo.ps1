foreach ($p in 8100, 8101, 8402, 8403, 8404, 8405, 8411, 8412, 8413) {
  $id = (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($id) { Stop-Process -Id $id -Force; "stopped :$p" }
}
