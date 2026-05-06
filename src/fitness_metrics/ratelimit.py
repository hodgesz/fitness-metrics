import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta


@dataclass
class RollingWindow:
    """Sliding window: limit N calls in the last `seconds`."""

    limit: int
    seconds: int
    calls: deque[float] = field(default_factory=deque)

    def wait(self) -> float:
        now = time.monotonic()
        cutoff = now - self.seconds
        while self.calls and self.calls[0] < cutoff:
            self.calls.popleft()
        if len(self.calls) < self.limit:
            return 0.0
        return self.calls[0] + self.seconds - now

    def record(self) -> None:
        self.calls.append(time.monotonic())


@dataclass
class DailyUtcWindow:
    """Fixed-day window: limit N calls between 00:00 UTC boundaries."""

    limit: int
    day: str = ""
    count: int = 0

    def _today(self) -> str:
        return datetime.now(UTC).strftime("%Y-%m-%d")

    def _seconds_to_next_midnight(self) -> float:
        now = datetime.now(UTC)
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        return (tomorrow - now).total_seconds()

    def wait(self) -> float:
        today = self._today()
        if today != self.day:
            self.day = today
            self.count = 0
        if self.count < self.limit:
            return 0.0
        return self._seconds_to_next_midnight()

    def record(self) -> None:
        today = self._today()
        if today != self.day:
            self.day = today
            self.count = 0
        self.count += 1


class RateLimiter:
    """Composite limiter — honors each sub-window simultaneously."""

    def __init__(self, windows: list):
        self.windows = windows

    def acquire(self) -> None:
        while True:
            sleep_for = max((w.wait() for w in self.windows), default=0.0)
            if sleep_for <= 0:
                for w in self.windows:
                    w.record()
                return
            # Log long sleeps so stalls are visible in the log
            if sleep_for > 60:
                now = datetime.now(UTC).strftime("%H:%M:%SZ")
                wake = (datetime.now(UTC) + timedelta(seconds=sleep_for)).strftime("%H:%M:%SZ")
                print(f"[ratelimit] sleeping {sleep_for:.0f}s at {now} (until ~{wake})", flush=True)
            time.sleep(sleep_for + 0.1)
