package companion.guard;

import java.util.HashMap;
import java.util.Map;
import java.util.Collections;
import java.util.UUID;

/**
 * Bounded, main-thread-only evidence for generic bot block mutations.
 * Placement history is conservative: once the bound is exceeded every
 * generic mining check is treated as protected until the plugin restarts.
 */
public final class ActionLedger {
    public record Point(UUID world, int x, int y, int z) {}
    public record Permit(UUID actor, String operation, Point point, String name) {}

    private static final int MAX_PLACED = 10_000;
    private static final int MAX_PERMITS = 1_024;
    private final Map<Point, String> placed = new HashMap<>();
    private final Map<Permit, Long> permits = new HashMap<>();
    private boolean saturated;

    public boolean recordPlacement(Point point, String name) {
        if (!placed.containsKey(point) && placed.size() >= MAX_PLACED) {
            saturated = true;
            return false;
        }
        placed.put(point, name);
        return true;
    }

    public boolean isPlaced(Point point) {
        return saturated || placed.containsKey(point);
    }

    public boolean hasPlacement(Point point) {
        return placed.containsKey(point);
    }

    public boolean isSaturated() {
        return saturated;
    }

    public void markSaturated() {
        saturated = true;
    }

    public Map<Point, String> placementSnapshot() {
        return Collections.unmodifiableMap(new HashMap<>(placed));
    }

    public void restorePlacement(Point point, String name) {
        if (placed.containsKey(point)) return;
        if (placed.size() >= MAX_PLACED) {
            saturated = true;
            return;
        }
        placed.put(point, name);
    }

    /**
     * A material name alone is never proof that a block is natural. The
     * caller must supply a server-configured safe mining region; placement
     * provenance remains protected even inside that region.
     */
    public boolean allowsNaturalMining(Point point, boolean configuredRegion) {
        return configuredRegion && !isPlaced(point);
    }

    public void remove(Point point) {
        placed.remove(point);
    }

    public void grant(Permit permit, long expiresAtMillis) {
        if (permits.size() >= MAX_PERMITS) permits.clear();
        permits.put(permit, expiresAtMillis);
    }

    public boolean consume(Permit permit, long nowMillis) {
        Long expiresAt = permits.remove(permit);
        return expiresAt != null && expiresAt >= nowMillis;
    }

    public void clear() {
        placed.clear();
        permits.clear();
        saturated = false;
    }
}
