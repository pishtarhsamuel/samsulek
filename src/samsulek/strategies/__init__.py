"""Strategies: pure functions of point-in-time data -> target weights.

A strategy NEVER sees a broker, router, risk engine or state store, and must not
import ``samsulek.execution``, ``samsulek.risk`` or ``samsulek.portfolio``
(enforced by tests/test_architecture.py).
"""
