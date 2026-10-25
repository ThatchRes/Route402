$ports = [ordered]@{8403="payout server"; 8404="router"; 8402="x402 seller"; 8411="provider: stablecoin"; 8413="provider: bank"; 8405="agent wallet"; 8101="workers"; 8100="gateway"}
foreach ($p in $ports.Keys) {
  $ok = try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $p); $c.Close(); $true } catch { $false }
  "{0,-6} {1,-22} {2}" -f $p, $ports[$p], $(if ($ok) { "UP" } else { "DOWN  <- check that window" })
}
