"""Circuit breaker for provider/model failures.

Free tiers throttle and providers wobble; without a breaker every
request re-pays the timeout for a model that's known to be down. Per
``provider:model`` key:

- a **rate limit** (429) opens the circuit immediately — the provider
  told us to back off, believe it
- other errors open it after ``failure_threshold`` consecutive failures
- open circuits are skipped during routing for ``cooldown_s`` seconds,
  then get one half-open trial; success closes, failure re-opens

If *every* candidate is cooling down the router tries them anyway
(degraded beats dead). All skips are recorded on the RoutingDecision.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from persona_twin.log import get_logger, kv

logger = get_logger("llm.breaker")

FAILURE_THRESHOLD = 2
COOLDOWN_S = 60.0
RATE_LIMIT_COOLDOWN_S = 120.0


def is_rate_limit(exc: Exception) -> bool:
    if getattr(exc, "status_code", None) == 429:
        return True
    return "ratelimit" in type(exc).__name__.lower()


@dataclass
class CircuitBreaker:
    failure_threshold: int = FAILURE_THRESHOLD
    cooldown_s: float = COOLDOWN_S
    rate_limit_cooldown_s: float = RATE_LIMIT_COOLDOWN_S
    clock: Callable[[], float] = time.monotonic
    _failures: dict[str, int] = field(default_factory=dict)
    _open_until: dict[str, float] = field(default_factory=dict)

    def record_success(self, key: str) -> None:
        self._failures.pop(key, None)
        self._open_until.pop(key, None)

    def record_failure(self, key: str, rate_limited: bool = False) -> None:
        self._failures[key] = self._failures.get(key, 0) + 1
        if rate_limited:
            self._open_until[key] = self.clock() + self.rate_limit_cooldown_s
            logger.warning(
                "circuit open (429) %s",
                kv(key=key, cooldown=self.rate_limit_cooldown_s),
            )
        elif self._failures[key] >= self.failure_threshold:
            self._open_until[key] = self.clock() + self.cooldown_s
            logger.warning(
                "circuit open %s",
                kv(key=key, failures=self._failures[key], cooldown=self.cooldown_s),
            )

    def is_open(self, key: str) -> bool:
        until = self._open_until.get(key)
        if until is None:
            return False
        if self.clock() >= until:
            # half-open: allow one trial; failure re-opens via record_failure
            self._open_until.pop(key, None)
            self._failures[key] = max(0, self.failure_threshold - 1)
            return False
        return True

    def cooling_down(self) -> dict[str, float]:
        """key -> seconds remaining (only currently-open circuits)."""
        now = self.clock()
        return {
            key: round(until - now, 1)
            for key, until in self._open_until.items()
            if until > now
        }
