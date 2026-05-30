from fitness_metrics.ratelimit import DailyUtcWindow, RateLimiter, RollingWindow


def test_rolling_window_allows_under_limit():
    w = RollingWindow(limit=3, seconds=60)
    assert w.wait() == 0.0
    w.record()
    assert w.wait() == 0.0


def test_rolling_window_blocks_at_limit():
    w = RollingWindow(limit=2, seconds=60)
    w.record()
    w.record()
    # At the limit, wait() should return a positive delay until the
    # oldest call ages out of the window.
    delay = w.wait()
    assert delay > 0
    assert delay <= 60


def test_daily_window_counts_and_blocks():
    w = DailyUtcWindow(limit=2)
    assert w.wait() == 0.0
    w.record()
    w.record()
    # Third call in the same UTC day must wait until next midnight.
    delay = w.wait()
    assert delay > 0


def test_daily_window_resets_on_new_day():
    w = DailyUtcWindow(limit=1)
    w.record()
    assert w.wait() > 0
    # Simulate the day rolling over.
    w.day = "1970-01-01"
    assert w.wait() == 0.0


def test_rate_limiter_records_across_windows():
    rolling = RollingWindow(limit=5, seconds=60)
    daily = DailyUtcWindow(limit=5)
    limiter = RateLimiter([rolling, daily])
    limiter.acquire()
    assert len(rolling.calls) == 1
    assert daily.count == 1
