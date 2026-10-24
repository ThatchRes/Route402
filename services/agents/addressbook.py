"""Every agent's address is derived from its seed, so nobody copies addresses from logs.
RulesBasedResolver = local address book (no Almanac / Agentverse lookup needed for the demo)."""
import os
from uagents.resolver import RulesBasedResolver
from uagents_core.identity import Identity

GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "8100"))
WORKERS_PORT = int(os.getenv("WORKERS_PORT", "8101"))


def addr(seed_env: str) -> str:
    return Identity.from_seed(os.environ[seed_env], 0).address


GATEWAY = addr("GATEWAY_SEED")
ROUTING = addr("ROUTING_SEED")
INVESTIGATION = addr("INVESTIGATION_SEED")
LIQUIDITY = addr("LIQUIDITY_SEED")
EXECUTOR = addr("EXECUTOR_SEED")
RECONCILIATION = addr("RECONCILIATION_SEED")

RESOLVER = RulesBasedResolver({
    GATEWAY: f"http://127.0.0.1:{GATEWAY_PORT}/submit",
    ROUTING: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    INVESTIGATION: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    LIQUIDITY: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    EXECUTOR: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    RECONCILIATION: f"http://127.0.0.1:{WORKERS_PORT}/submit",
})
