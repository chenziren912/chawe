package chawe;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

final class RateLimiter {
    private final Map<String, Window> windows = new HashMap<>();

    synchronized boolean allow(String key, int limit, long seconds) {
        long now = Instant.now().getEpochSecond();
        if (windows.size() > 10_000) windows.entrySet().removeIf(e -> e.getValue().until() <= now);
        Window window = windows.get(key);
        if (window == null || window.until() <= now) {
            windows.put(key, new Window(1, now + seconds));
            return true;
        }
        if (window.count() >= limit) return false;
        windows.put(key, new Window(window.count() + 1, window.until()));
        return true;
    }

    private record Window(int count, long until) { }
}
