"""Every agent's address is derived from its seed, so nobody copies addresses from logs.
RulesBasedResolver = local address book (no Almanac / Agentverse lookup needed for the demo)."""
import os
from uagents.resolver import GlobalResolver, Resolver, RulesBasedResolver
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
# Compliance agent: own seed if set, else derived from the gateway seed (no new .env entry needed)
COMPLIANCE_SEED = os.getenv("COMPLIANCE_SEED") or (os.environ["GATEWAY_SEED"] + ":compliance")
COMPLIANCE = Identity.from_seed(COMPLIANCE_SEED, 0).address

class LocalFirstResolver(Resolver):
    """Our own agents resolve from the local book (fast, no network); anyone else (ASI:One, Agentverse users)
    resolves through the Almanac, so the concierge can reply to chat senders."""
    def __init__(self, rules: dict):
        self._local, self._rules, self._global = RulesBasedResolver(rules), rules, GlobalResolver()

    async def resolve(self, destination: str):
        if destination in self._rules:
            return await self._local.resolve(destination)
        return await self._global.resolve(destination)


RESOLVER = LocalFirstResolver({
    GATEWAY: f"http://127.0.0.1:{GATEWAY_PORT}/submit",
    ROUTING: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    INVESTIGATION: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    LIQUIDITY: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    EXECUTOR: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    RECONCILIATION: f"http://127.0.0.1:{WORKERS_PORT}/submit",
    COMPLIANCE: f"http://127.0.0.1:{WORKERS_PORT}/submit",
})
