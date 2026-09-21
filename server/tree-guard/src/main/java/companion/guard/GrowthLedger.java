package companion.guard;

import java.util.*;

/** Main-thread only. Evidence deliberately expires on restart and chunk unload. */
public final class GrowthLedger {
    public static boolean isGatherable(String name) {
        return Set.of("OAK_LOG","SPRUCE_LOG","BIRCH_LOG","JUNGLE_LOG","ACACIA_LOG","DARK_OAK_LOG","MANGROVE_LOG","CHERRY_LOG","PALE_OAK_LOG","CRIMSON_STEM","WARPED_STEM").contains(name);
    }
    public record Point(UUID world, int x, int y, int z) {
        public boolean near(Point other) {
            return world.equals(other.world) && Math.abs((long)x-other.x)<=1
                && Math.abs((long)y-other.y)<=1 && Math.abs((long)z-other.z)<=1;
        }
    }
    private final Map<Point, String> logs = new HashMap<>();
    private final Map<Point, Set<Point>> trees = new HashMap<>();
    private final Set<Set<Point>> evidence = Collections.newSetFromMap(new IdentityHashMap<>());
    public void grew(Map<Point, String> grown) {
        // A bounded ledger fails closed rather than evicting individual protections.
        if (grown.size() > 512 || evidence.stream().mapToInt(Set::size).sum() + grown.size() > 10_000) { clear(); return; }
        if (grown.isEmpty()) return;
        Set<Point> tree = Set.copyOf(grown.keySet());
        evidence.add(tree);
        for (var entry : grown.entrySet()) {
            logs.put(entry.getKey(), entry.getValue());
            trees.put(entry.getKey(), tree);
        }
    }
    public String decision(Point point, String current, boolean protectedArea, boolean surroundingsSafe) {
        if (protectedArea || !surroundingsSafe) return "protected";
        String expected = logs.get(point);
        if (expected == null) return "unknown";
        return expected.equals(current) ? "allowed" : "changed";
    }
    public boolean known(Point point, String name) { return name.equals(logs.get(point)); }
    public void changedNear(Point point) {
        // Each growth footprint is visited once, with at most 10,000 retained points.
        var iterator=evidence.iterator();
        while(iterator.hasNext()) {
            Set<Point> tree=iterator.next();
            if(tree.stream().noneMatch(p -> p.near(point))) continue;
            for(Point key:tree) if(trees.get(key)==tree) { logs.remove(key);trees.remove(key); }
            iterator.remove();
        }
    }
    public Set<Point> tree(Point point) { return trees.getOrDefault(point, Set.of(point)); }
    public void broken(Point point, String material, boolean configuredBot) {
        if (configuredBot && isGatherable(material.toUpperCase(Locale.ROOT)) && known(point, material)) harvested(point);
        else changedNear(point);
    }
    public void harvested(Point point) {
        logs.remove(point);Set<Point> tree=trees.remove(point);
        if(tree!=null && tree.stream().noneMatch(p -> trees.get(p)==tree)) evidence.remove(tree);
    }
    public void clear() { logs.clear(); trees.clear(); evidence.clear(); }
}
