"""The M3 backtester: replays daily bars through the SAME cycle, sizing and risk code as the bot.

A backtest never writes the bot's files, never reads secrets and never trades: every run
gets fresh in-memory parts (risk store, ledger, decision log, simulated broker) and one
clock that only moves forward. Strategies still output target weights only, and every
order still passes the risk engine. Nothing outside ``cli.py`` and this package may
import it (tests/test_architecture_m3.py, rule A1).
"""
