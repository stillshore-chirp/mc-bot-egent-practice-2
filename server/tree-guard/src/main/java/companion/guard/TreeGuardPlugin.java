package companion.guard;

import java.nio.charset.StandardCharsets;
import java.util.*;
import org.bukkit.*;
import org.bukkit.block.*;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.*;
import org.bukkit.event.entity.*;
import org.bukkit.event.world.*;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.PluginMessageListener;

public final class TreeGuardPlugin extends JavaPlugin implements Listener, PluginMessageListener {
    private static final String CHANNEL = "companion:tree_guard";
    private final GrowthLedger ledger = new GrowthLedger();
    private Set<String> botNames = Set.of();
    private List<Region> protectedRegions = List.of();
    private record Region(String world, int x1, int y1, int z1, int x2, int y2, int z2) {
        boolean contains(Block b) {
            return world.equals(b.getWorld().getName()) && b.getX()>=x1 && b.getX()<=x2
                && b.getY()>=y1 && b.getY()<=y2 && b.getZ()>=z1 && b.getZ()<=z2;
        }
    }
    @Override public void onEnable() {
        saveDefaultConfig();
        Set<String> names = new HashSet<>();
        for (String name : getConfig().getStringList("bot-names")) names.add(name.toLowerCase(Locale.ROOT));
        botNames = Set.copyOf(names);
        List<Region> regions = new ArrayList<>();
        for (Map<?,?> value : getConfig().getMapList("protected-regions")) {
            try {
                String world = (String)value.get("world");
                List<?> min = (List<?>)value.get("min"), max = (List<?>)value.get("max");
                if (world == null || min.size()!=3 || max.size()!=3) throw new IllegalArgumentException();
                int[] lo = new int[3], hi = new int[3];
                for (int i=0;i<3;i++) {
                    lo[i]=Integer.parseInt(min.get(i).toString()); hi[i]=Integer.parseInt(max.get(i).toString());
                    if (lo[i]>hi[i]) throw new IllegalArgumentException();
                }
                regions.add(new Region(world,lo[0],lo[1],lo[2],hi[0],hi[1],hi[2]));
            } catch (RuntimeException invalid) { throw new IllegalArgumentException("Invalid protected region configuration"); }
        }
        protectedRegions = List.copyOf(regions);
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getMessenger().registerIncomingPluginChannel(this, CHANNEL, this);
        getServer().getMessenger().registerOutgoingPluginChannel(this, CHANNEL);
    }
    @Override public void onDisable() { ledger.clear(); }
    private boolean bot(Player p) { return botNames.contains(p.getName().toLowerCase(Locale.ROOT)); }
    private GrowthLedger.Point point(Block b) { return new GrowthLedger.Point(b.getWorld().getUID(), b.getX(),b.getY(),b.getZ()); }
    private static boolean log(Material material) { return GrowthLedger.isGatherable(material.name()); }
    private static boolean root(Material material) { return material==Material.MANGROVE_ROOTS || material==Material.MUDDY_MANGROVE_ROOTS; }
    private String name(Block b) { return b.getType().name().toLowerCase(Locale.ROOT); }
    private boolean protectedArea(Block b) { return protectedRegions.stream().anyMatch(r -> r.contains(b)); }
    private boolean safeSurroundings(Block b) {
        for (int dx=-1;dx<=1;dx++) for (int dy=-1;dy<=1;dy++) for (int dz=-1;dz<=1;dz++) {
            if (dx==0 && dy==0 && dz==0) continue;
            int x=b.getX()+dx, y=b.getY()+dy, z=b.getZ()+dz;
            if (y<b.getWorld().getMinHeight() || y>=b.getWorld().getMaxHeight() || !b.getWorld().isChunkLoaded(x>>4,z>>4)) return false;
            Block neighbor=b.getWorld().getBlockAt(x,y,z);
            if (protectedArea(neighbor)) return false;
            Material type=neighbor.getType();
            if (type.isAir() || Tag.LEAVES.isTagged(type) || type==Material.VINE || type==Material.SHORT_GRASS || type==Material.TALL_GRASS || type==Material.NETHER_WART_BLOCK || type==Material.WARPED_WART_BLOCK || type==Material.SHROOMLIGHT || type.name().startsWith("WEEPING_VINES") || type.name().startsWith("TWISTING_VINES")) continue;
            if ((log(type) || root(type)) && ledger.known(point(neighbor),name(neighbor))) continue;
            if (b.getType()==Material.MANGROVE_LOG && type==Material.WATER) continue;
            // Soil in the layer under the log supports the tree; side-level building blocks fail closed.
            if (dy==-1 && (type==Material.DIRT || type==Material.GRASS_BLOCK || type==Material.PODZOL || type==Material.ROOTED_DIRT || type==Material.MUD || type==Material.CRIMSON_NYLIUM || type==Material.WARPED_NYLIUM)) continue;
            return false;
        }
        return true;
    }
    private String decision(Block b) {
        boolean safe = true;
        for (GrowthLedger.Point p : ledger.tree(point(b))) {
            if (!b.getWorld().isChunkLoaded(p.x()>>4,p.z()>>4)) { safe=false; break; }
            Block member=b.getWorld().getBlockAt(p.x(),p.y(),p.z());
            if (protectedArea(member) || (log(member.getType()) && !safeSurroundings(member))) { safe=false; break; }
        }
        return ledger.decision(point(b),name(b),protectedArea(b),safe);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void grow(StructureGrowEvent e) {
        Map<GrowthLedger.Point,String> grown = new HashMap<>();
        for (BlockState state:e.getBlocks()) if (log(state.getType()) || root(state.getType())) {
            Block previous=state.getBlock();
            if(root(state.getType())) {
                Material old=previous.getType();
                if(!old.isAir() && old!=Material.WATER && old!=Material.DIRT && old!=Material.MUD && old!=Material.GRASS_BLOCK && old!=Material.ROOTED_DIRT)continue;
                grown.put(point(previous),state.getType().name().toLowerCase(Locale.ROOT));continue;
            }
            // An existing solid block is never retroactively authorized by growth.
            if (!previous.getType().isAir() && !Tag.SAPLINGS.isTagged(previous.getType()) && !Tag.LEAVES.isTagged(previous.getType()) && previous.getType()!=Material.CRIMSON_FUNGUS && previous.getType()!=Material.WARPED_FUNGUS) continue;
            grown.put(point(previous),state.getType().name().toLowerCase(Locale.ROOT));
        }
        ledger.grew(grown);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void place(BlockPlaceEvent e) { ledger.changedNear(point(e.getBlock())); }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true)
    public void protectBreak(BlockBreakEvent e) {
        if (bot(e.getPlayer()) && log(e.getBlock().getType()) && !decision(e.getBlock()).equals("allowed")) e.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void didBreak(BlockBreakEvent e) {
        ledger.broken(point(e.getBlock()), e.getBlock().getType().name().toLowerCase(Locale.ROOT), bot(e.getPlayer()));
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void piston(BlockPistonExtendEvent e) { ledger.changedNear(e.getBlocks().stream().map(this::point).toList()); }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void retract(BlockPistonRetractEvent e) { ledger.changedNear(e.getBlocks().stream().map(this::point).toList()); }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void burn(BlockBurnEvent e) { ledger.changedNear(point(e.getBlock())); }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void entityChange(EntityChangeBlockEvent e) { ledger.changedNear(point(e.getBlock())); }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void explode(EntityExplodeEvent e) { ledger.changedNear(e.blockList().stream().map(this::point).toList()); }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void blockExplode(BlockExplodeEvent e) { ledger.changedNear(e.blockList().stream().map(this::point).toList()); }
    @EventHandler(priority=EventPriority.MONITOR)
    public void unload(ChunkUnloadEvent e) { ledger.clear(); }
    @Override public void onPluginMessageReceived(String channel, Player player, byte[] bytes) {
        if (!CHANNEL.equals(channel) || !bot(player) || bytes.length>256) return;
        String[] parts=new String(bytes,StandardCharsets.UTF_8).split("\\|",-1);
        if (parts.length!=5 || !parts[0].matches("[a-f0-9-]{36}") || !parts[4].matches("[a-z_]{1,40}")) return;
        String result="unknown";
        try {
            int x=Integer.parseInt(parts[1]), y=Integer.parseInt(parts[2]), z=Integer.parseInt(parts[3]);
            World world=player.getWorld();
            if (Math.abs((long)x)>30_000_000 || Math.abs((long)z)>30_000_000 || y<world.getMinHeight() || y>=world.getMaxHeight()) return;
            if (world.isChunkLoaded(x>>4,z>>4) && player.getLocation().distanceSquared(new Location(world,x,y,z))<=128*128) {
                Block b=world.getBlockAt(x,y,z);
                result=parts[4].equals(name(b)) && log(b.getType()) ? decision(b) : "changed";
            }
        } catch (NumberFormatException invalid) { return; }
        player.sendPluginMessage(this,CHANNEL,(parts[0]+"|"+result).getBytes(StandardCharsets.UTF_8));
    }
}
