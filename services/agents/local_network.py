"""uAgents' installed ASGI server reads this host constant when it starts.
Local simulation must not expose its demo endpoints on LAN interfaces. Live mailbox mode is unchanged.
"""
import os


def configure_local_network():
    if os.getenv("LOCAL_ROUTING", "0") == "1":
        import uagents.asgi
        uagents.asgi.HOST = "127.0.0.1"
