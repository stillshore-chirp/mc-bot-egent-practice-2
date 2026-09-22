package companion.guard;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import com.google.gson.*;
import org.bukkit.*;
import org.bukkit.block.*;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.*;
import org.bukkit.event.entity.*;
import org.bukkit.event.world.*;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.PluginMessageListener;

public final class TreeGuardPlugin extends JavaPlugin implements Listener, PluginMessageListener {
    private static final String CHANNEL = "companion:tree_guard";
    private static final String ACTION_CHANNEL = "companion:action_guard";
    private static final int ACTION_LEDGER_SCHEMA_VERSION = 1;
    private final GrowthLedger ledger = new GrowthLedger();
    private final ActionLedger actionLedger = new ActionLedger();
    private Set<String> botNames = Set.of();
    private List<Region> protectedRegions = List.of();
    private List<Region> naturalResourceRegions = List.of();
    private File actionLedgerFile;
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
        protectedRegions = readRegions("protected-regions");
        naturalResourceRegions = readRegions("natural-resource-regions");
        actionLedgerFile = new File(getDataFolder(), "action-ledger.yml");
        loadActionLedger();
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getMessenger().registerIncomingPluginChannel(this, CHANNEL, this);
        getServer().getMessenger().registerOutgoingPluginChannel(this, CHANNEL);
        getServer().getMessenger().registerIncomingPluginChannel(this, ACTION_CHANNEL, this);
        getServer().getMessenger().registerOutgoingPluginChannel(this, ACTION_CHANNEL);
        StorageIdentity storage=new StorageIdentity(this,this::bot);
        getServer().getMessenger().registerIncomingPluginChannel(this,StorageIdentity.CHANNEL,storage);
        getServer().getPluginManager().registerEvents(storage,this);
        getServer().getMessenger().registerOutgoingPluginChannel(this,StorageIdentity.CHANNEL);
    }
    private List<Region> readRegions(String key) {
        List<Region> regions = new ArrayList<>();
        for (Map<?,?> value : getConfig().getMapList(key)) {
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
        return List.copyOf(regions);
    }
    @Override public void onDisable() {
        saveActionLedger();
        ledger.clear();
        actionLedger.clear();
    }

    private void loadActionLedger() {
        File file = actionLedgerFile;
        if (file == null || !file.isFile()) return;
        try {
            YamlConfiguration config = YamlConfiguration.loadConfiguration(file);
            if (!validActionLedgerSchema(config)) throw new IllegalArgumentException();
            Object rawPlacements = config.get("placements");
            if (!(rawPlacements instanceof List<?> placementList)) throw new IllegalArgumentException();
            for (Object rawValue : placementList) {
                if (!(rawValue instanceof Map<?, ?> value)) throw new IllegalArgumentException();
                Object world = value.get("world");
                Object x = value.get("x"), y = value.get("y"), z = value.get("z");
                Object name = value.get("name");
                if (!(world instanceof String worldName) || !(name instanceof String blockName)
                    || x == null || y == null || z == null || blockName.isBlank()) {
                    throw new IllegalArgumentException();
                }
                actionLedger.restorePlacement(new ActionLedger.Point(
                    UUID.fromString(worldName), Integer.parseInt(x.toString()),
                    Integer.parseInt(y.toString()), Integer.parseInt(z.toString())), blockName);
            }
            if (Boolean.TRUE.equals(config.get("saturated"))) actionLedger.markSaturated();
        } catch (RuntimeException invalid) {
            actionLedger.markSaturated();
            saveActionLedger();
            getLogger().warning("汎用操作の配置履歴を読み込めないため、採掘を保守的に停止します。");
        }
    }

    static boolean validActionLedgerSchema(YamlConfiguration config) {
        Object version = config.get("schema-version");
        Object placements = config.get("placements");
        Object saturated = config.get("saturated");
        return version instanceof Number number
            && number.intValue() == ACTION_LEDGER_SCHEMA_VERSION
            && placements instanceof List<?>
            && saturated instanceof Boolean;
    }

    private void saveActionLedger() {
        File file = actionLedgerFile;
        if (file == null) return;
        try {
            if (!getDataFolder().exists() && !getDataFolder().mkdirs()) {
                throw new IOException("data directory unavailable");
            }
            YamlConfiguration config = new YamlConfiguration();
            List<Map<String, Object>> placements = new ArrayList<>();
            for (Map.Entry<ActionLedger.Point, String> entry : actionLedger.placementSnapshot().entrySet()) {
                ActionLedger.Point point = entry.getKey();
                Map<String, Object> value = new LinkedHashMap<>();
                value.put("world", point.world().toString());
                value.put("x", point.x());
                value.put("y", point.y());
                value.put("z", point.z());
                value.put("name", entry.getValue());
                placements.add(value);
            }
            config.set("schema-version", ACTION_LEDGER_SCHEMA_VERSION);
            config.set("placements", placements);
            config.set("saturated", actionLedger.isSaturated());
            config.save(file);
        } catch (IOException | RuntimeException failure) {
            actionLedger.markSaturated();
            getLogger().warning("汎用操作の配置履歴を保存できないため、採掘を保守的に停止します。");
        }
    }
    private boolean bot(Player p) { return botNames.contains(p.getName().toLowerCase(Locale.ROOT)); }
    private void saturateActionLedger() {
        actionLedger.markSaturated();
        // Persist at the event boundary so a crash cannot reopen a stale
        // unsaturated ledger on the next server start.
        saveActionLedger();
    }
    private GrowthLedger.Point point(Block b) { return new GrowthLedger.Point(b.getWorld().getUID(), b.getX(),b.getY(),b.getZ()); }
    private static boolean log(Material material) { return GrowthLedger.isGatherable(material.name()); }
    private static boolean root(Material material) { return material==Material.MANGROVE_ROOTS || material==Material.MUDDY_MANGROVE_ROOTS; }
    private static boolean growthDecoration(Material material) { return material==Material.MOSS_CARPET || material==Material.MANGROVE_PROPAGULE; }
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
            if ((log(type) || root(type) || growthDecoration(type)) && ledger.known(point(neighbor),name(neighbor))) continue;
            if (TreeSupport.naturalSupport(b.getType().name(),type.name(),dx,dy,dz)) continue;
            return false;
        }
        return true;
    }
    private String decision(Block b) {
        boolean safe = true;
        for (GrowthLedger.Point p : ledger.tree(point(b))) {
            if (!b.getWorld().isChunkLoaded(p.x()>>4,p.z()>>4)) { safe=false; break; }
            Block member=b.getWorld().getBlockAt(p.x(),p.y(),p.z());
            if (protectedArea(member) || ((log(member.getType()) || root(member.getType()) || growthDecoration(member.getType())) && !safeSurroundings(member))) { safe=false; break; }
        }
        return ledger.decision(point(b),name(b),protectedArea(b),safe);
    }

    private ActionLedger.Point actionPoint(Block b) {
        return new ActionLedger.Point(b.getWorld().getUID(), b.getX(), b.getY(), b.getZ());
    }

    private static boolean naturalResource(Material material) {
        String name = material.name();
        if (name.endsWith("_ORE") || name.equals("ANCIENT_DEBRIS")) return true;
        return Set.of(
            "STONE", "DEEPSLATE", "TUFF", "CALCITE", "DIORITE", "ANDESITE", "GRANITE",
            "NETHERRACK", "BASALT", "BLACKSTONE", "END_STONE", "DIRT", "COARSE_DIRT",
            "ROOTED_DIRT", "GRASS_BLOCK", "SAND", "RED_SAND", "GRAVEL", "CLAY", "SOUL_SAND",
            "SOUL_SOIL", "MUD", "MANGROVE_MUD", "ICE", "PACKED_ICE", "SNOW_BLOCK"
        ).contains(name);
    }

    private String genericMineDecision(Block block) {
        if (protectedArea(block)) return "protected";
        boolean configuredRegion = naturalResourceRegions.stream().anyMatch(r -> r.contains(block));
        if (!actionLedger.allowsNaturalMining(actionPoint(block), configuredRegion)) {
            return actionLedger.isPlaced(actionPoint(block)) ? "protected" : "unknown";
        }
        return naturalResource(block.getType()) ? "allowed" : "unknown";
    }

    private boolean inReach(Player player, Block block, double maxDistance) {
        return player.getWorld().equals(block.getWorld())
            && player.getLocation().distanceSquared(block.getLocation()) <= maxDistance * maxDistance;
    }

    private void sendActionResult(Player player, String id, String decision) {
        JsonObject result = new JsonObject();
        result.addProperty("id", id);
        result.addProperty("decision", decision);
        player.sendPluginMessage(this, ACTION_CHANNEL, result.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void handleActionMessage(Player player, byte[] bytes) {
        if (!bot(player) || bytes.length > 1024) return;
        try {
            JsonObject request = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
            String id = request.get("id").getAsString();
            String operation = request.get("operation").getAsString();
            String requestedName = request.get("name").getAsString().toLowerCase(Locale.ROOT);
            JsonObject position = request.getAsJsonObject("position");
            int x = position.get("x").getAsInt(), y = position.get("y").getAsInt(), z = position.get("z").getAsInt();
            if (!id.matches("[a-f0-9-]{36}") || !Set.of("mine", "place").contains(operation)
                || !requestedName.matches("[a-z0-9_]{1,64}")) return;
            World world = player.getWorld();
            if (Math.abs((long)x) > 30_000_000 || Math.abs((long)z) > 30_000_000
                || y < world.getMinHeight() || y >= world.getMaxHeight()) return;
            Block block = world.getBlockAt(x, y, z);
            if (!inReach(player, block, 6)) { sendActionResult(player, id, "unknown"); return; }
            String decision;
            if (operation.equals("mine")) {
                decision = requestedName.equals(name(block)) && log(block.getType())
                    ? decision(block) : requestedName.equals(name(block)) ? genericMineDecision(block) : "changed";
                if (decision.equals("allowed")) {
                    actionLedger.grant(new ActionLedger.Permit(player.getUniqueId(), operation, actionPoint(block), requestedName), System.currentTimeMillis() + 3_000);
                }
            } else {
                decision = block.getType().isAir() && !protectedArea(block) && !actionLedger.isSaturated()
                    ? "allowed" : "protected";
                if (decision.equals("allowed")) {
                    actionLedger.grant(new ActionLedger.Permit(player.getUniqueId(), operation, actionPoint(block), requestedName), System.currentTimeMillis() + 3_000);
                }
            }
            sendActionResult(player, id, decision);
        } catch (RuntimeException invalid) {
            // Invalid action requests are fail-closed and receive no permit.
        }
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void grow(StructureGrowEvent e) {
        Map<GrowthLedger.Point,String> grown = new HashMap<>();
        for (BlockState state:e.getBlocks()) if (log(state.getType()) || root(state.getType()) || growthDecoration(state.getType())) {
            Block previous=state.getBlock();
            if(growthDecoration(state.getType())) {
                if(previous.getType().isAir())grown.put(point(previous),state.getType().name().toLowerCase(Locale.ROOT));
                continue;
            }
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
    public void place(BlockPlaceEvent e) {
        ledger.changedNear(point(e.getBlock()));
        actionLedger.recordPlacement(actionPoint(e.getBlock()), name(e.getBlock()));
        saveActionLedger();
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true)
    public void protectBreak(BlockBreakEvent e) {
        if (!bot(e.getPlayer())) return;
        if (log(e.getBlock().getType())) {
            if (!decision(e.getBlock()).equals("allowed")) e.setCancelled(true);
            return;
        }
        if (actionLedger.isSaturated()) { e.setCancelled(true); return; }
        ActionLedger.Permit permit = new ActionLedger.Permit(
            e.getPlayer().getUniqueId(), "mine", actionPoint(e.getBlock()), name(e.getBlock()));
        if (!actionLedger.consume(permit, System.currentTimeMillis())) e.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true)
    public void protectPlace(BlockPlaceEvent e) {
        if (!bot(e.getPlayer())) return;
        ActionLedger.Permit permit = new ActionLedger.Permit(
            e.getPlayer().getUniqueId(), "place", actionPoint(e.getBlock()), name(e.getBlock()));
        if (!actionLedger.consume(permit, System.currentTimeMillis())) e.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void didBreak(BlockBreakEvent e) {
        ledger.broken(point(e.getBlock()), e.getBlock().getType().name().toLowerCase(Locale.ROOT), bot(e.getPlayer()));
        actionLedger.remove(actionPoint(e.getBlock()));
    }
    private void invalidateMovedPlacements(Collection<Block> blocks) {
        if (blocks.stream().map(this::actionPoint).anyMatch(actionLedger::hasPlacement)) {
            // The new coordinates depend on piston mechanics. Stop generic
            // mining until an operator re-establishes a safe provenance set.
            saturateActionLedger();
        }
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void piston(BlockPistonExtendEvent e) {
        ledger.changedNear(e.getBlocks().stream().map(this::point).toList());
        invalidateMovedPlacements(e.getBlocks());
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void retract(BlockPistonRetractEvent e) {
        ledger.changedNear(e.getBlocks().stream().map(this::point).toList());
        invalidateMovedPlacements(e.getBlocks());
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void burn(BlockBurnEvent e) {
        ledger.changedNear(point(e.getBlock()));
        actionLedger.remove(actionPoint(e.getBlock()));
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void entityChange(EntityChangeBlockEvent e) {
        ledger.changedNear(point(e.getBlock()));
        if (actionLedger.hasPlacement(actionPoint(e.getBlock()))) saturateActionLedger();
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void flow(BlockFromToEvent e) {
        ledger.changedNear(List.of(point(e.getBlock()), point(e.getToBlock())));
        if (actionLedger.hasPlacement(actionPoint(e.getBlock()))
            || actionLedger.hasPlacement(actionPoint(e.getToBlock()))) saturateActionLedger();
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void explode(EntityExplodeEvent e) {
        ledger.changedNear(e.blockList().stream().map(this::point).toList());
        e.blockList().forEach(block -> actionLedger.remove(actionPoint(block)));
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void blockExplode(BlockExplodeEvent e) {
        ledger.changedNear(e.blockList().stream().map(this::point).toList());
        e.blockList().forEach(block -> actionLedger.remove(actionPoint(block)));
    }
    @EventHandler(priority=EventPriority.MONITOR)
    public void unload(ChunkUnloadEvent e) {
        // Growth history is local to a loaded chunk. Placement provenance is
        // persisted separately and must survive unload to protect structures.
        ledger.clear();
    }
    @Override public void onPluginMessageReceived(String channel, Player player, byte[] bytes) {
        if (ACTION_CHANNEL.equals(channel)) { handleActionMessage(player, bytes); return; }
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
