"""Register the running concierge (gateway) on Agentverse as a mailbox agent, so ASI:One can find and message it.
Usage (gateway must be running with ENABLE_CHAT=1):  python register_agentverse.py
Needs AGENTVERSE_API_KEY in .env (agentverse.ai -> profile -> API Keys). Same effect as the inspector's Connect -> Mailbox."""
import os
import sys
import httpx
from addressbook import GATEWAY, GATEWAY_PORT

key = os.getenv("AGENTVERSE_API_KEY", "")
if not key:
    sys.exit("Set AGENTVERSE_API_KEY in .env (agentverse.ai -> profile -> API Keys), or click the inspector link the gateway prints.")
r = httpx.post(f"http://127.0.0.1:{GATEWAY_PORT}/connect", json={"user_token": key, "agent_type": "mailbox"}, timeout=60)
print(r.status_code, r.text)
if r.is_success and r.json().get("success"):
    print(f"\nregistered. Agent address: {GATEWAY}")
    print(f"profile:  https://agentverse.ai/agents/details/{GATEWAY}/profile")
    print(f"ASI:One:  open https://asi1.ai and message @{GATEWAY}  (e.g. 'pay my Canadian suppliers this week')")
else:
    print("not registered: check the key, that the gateway runs with ENABLE_CHAT=1, and that this machine can reach agentverse.ai")
