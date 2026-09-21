package companion.guard;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Predicate;
import org.bukkit.*;
import org.bukkit.block.*;
import org.bukkit.entity.Player;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.event.*;
import org.bukkit.event.inventory.*;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.PluginMessageListener;

/** Identifies explicitly nominated containers; never transfers any inventory. */
public final class StorageIdentity implements PluginMessageListener, Listener {
    public static final String CHANNEL="companion:storage";
    private final JavaPlugin plugin;
    private final Predicate<Player> authorized;
    private final NamespacedKey identityKey;
    private String epoch=UUID.randomUUID().toString();
    private final Map<String,Map<UUID,Long>> observers=new HashMap<>();
    private final Map<String,Map<UUID,String>> resources=new HashMap<>();
    private Map<UUID,Long> observers(String identity) {
        if(!observers.containsKey(identity) && observers.size()>=1024) { observers.clear();resources.clear();epoch=UUID.randomUUID().toString(); }
        return observers.computeIfAbsent(identity,key->new HashMap<>());
    }
    private void changed(Inventory inventory, UUID actor) {
        Location location=inventory.getLocation();if(location==null)return;
        String id=identity(location.getBlock(),false);if(id==null)return;
        Map<UUID,Long> tracked=observers.get(id);if(tracked==null)return;
        tracked.replaceAll((player,revision)->player.equals(actor)?revision:revision+1);
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true)
    public void protectClick(InventoryClickEvent e) {
        if(!(e.getWhoClicked() instanceof Player player) || !authorized.test(player))return;
        Location location=e.getView().getTopInventory().getLocation();if(location==null)return;
        if(!(location.getBlock().getState() instanceof Chest))return;
        String id=identity(location.getBlock(),false);
        String resource=id==null?null:resources.getOrDefault(id,Map.of()).get(player.getUniqueId());
        ItemStack cursor=e.getCursor(),current=e.getCurrentItem();
        String cursorName=cursor==null||cursor.getType().isAir()?null:cursor.getType().name();
        String currentName=current==null||current.getType().isAir()?null:current.getType().name();
        if(e.getRawSlot()<0 || resource==null || !DepositPolicy.allows(e.getRawSlot()<e.getView().getTopInventory().getSize(),e.getAction().name(),cursorName,currentName,resource))e.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true)
    public void protectReservedSlot(EntityPickupItemEvent e) {
        if(e.getEntity() instanceof Player player && authorized.test(player)) {
            Location location=player.getOpenInventory().getTopInventory().getLocation();
            if(location!=null && location.getBlock().getState() instanceof Chest)e.setCancelled(true);
        }
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true)
    public void protectDrag(InventoryDragEvent e) {
        if(e.getWhoClicked() instanceof Player player && authorized.test(player) && e.getView().getTopInventory().getLocation()!=null)e.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void click(InventoryClickEvent e) { changed(e.getView().getTopInventory(),e.getWhoClicked().getUniqueId()); }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void drag(InventoryDragEvent e) { changed(e.getView().getTopInventory(),e.getWhoClicked().getUniqueId()); }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void move(InventoryMoveItemEvent e) { changed(e.getSource(),null);changed(e.getDestination(),null); }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void pickup(InventoryPickupItemEvent e) { changed(e.getInventory(),null); }
    private int count(Inventory inventory,Material material) {
        int total=0;for(ItemStack item:inventory.getContents())if(item!=null && item.getType()==material)total+=item.getAmount();return total;
    }
    public StorageIdentity(JavaPlugin plugin, Predicate<Player> authorized) {
        this.plugin=plugin;this.authorized=authorized;identityKey=new NamespacedKey(plugin,"chest_identity");
    }
    private String chestIdentity(Chest chest, boolean register) {
        if(chest.isLocked())return null;
        String value=chest.getPersistentDataContainer().get(identityKey,PersistentDataType.STRING);
        if(value==null && register) {
            value=UUID.randomUUID().toString();chest.getPersistentDataContainer().set(identityKey,PersistentDataType.STRING,value);
            if(!chest.update(false,false))return null;
        }
        if(value==null || !value.matches("[a-f0-9-]{36}"))return null;
        return chest.getX()+","+chest.getY()+","+chest.getZ()+":"+value+":"+chest.getBlockData().getAsString();
    }
    private String identity(Block block, boolean register) {
        if(!(block.getState() instanceof Chest chest))return null;
        for(int dx=-1;dx<=1;dx++)for(int dz=-1;dz<=1;dz++)if(!block.getWorld().isChunkLoaded((block.getX()+dx)>>4,(block.getZ()+dz)>>4))return null;
        InventoryHolder holder=chest.getInventory().getHolder();
        if(holder instanceof DoubleChest pair) {
            if(!(pair.getLeftSide() instanceof Chest left) || !(pair.getRightSide() instanceof Chest right))return null;
            String a=chestIdentity(left,register),b=chestIdentity(right,register);
            if(a==null || b==null)return null;
            return a.compareTo(b)<0?a+";"+b:b+";"+a;
        }
        return chestIdentity(chest,register);
    }
    @Override public void onPluginMessageReceived(String channel,Player player,byte[] bytes) {
        if(!CHANNEL.equals(channel) || !authorized.test(player) || bytes.length>1024)return;
        try {
            JsonObject request=JsonParser.parseString(new String(bytes,StandardCharsets.UTF_8)).getAsJsonObject();
            String id=request.get("id").getAsString(),operation=request.get("operation").getAsString();
            if(!id.matches("[a-f0-9-]{36}"))return;
            String identity=null;Block target=null;
            if(operation.equals("inspect") || operation.equals("register")) {
                JsonObject p=request.getAsJsonObject("position");
                int x=Integer.parseInt(p.get("x").getAsString()),y=Integer.parseInt(p.get("y").getAsString()),z=Integer.parseInt(p.get("z").getAsString());
                World world=player.getWorld();boolean register=operation.equals("register");
                if(Math.abs((long)x)>30_000_000 || Math.abs((long)z)>30_000_000 || y<world.getMinHeight() || y>=world.getMaxHeight())return;
                if(world.isChunkLoaded(x>>4,z>>4) && player.getLocation().distanceSquared(new Location(world,x,y,z))<=(register?25:128*128)) { target=world.getBlockAt(x,y,z);identity=identity(target,register); }
            } else if(!operation.equals("world"))return;
            Location observed=player.getLocation();
            JsonObject result=new JsonObject();result.addProperty("id",id);result.addProperty("worldId",observed.getWorld().getUID().toString());
            JsonObject observedPosition=new JsonObject();observedPosition.addProperty("x",observed.getX());observedPosition.addProperty("y",observed.getY());observedPosition.addProperty("z",observed.getZ());result.add("position",observedPosition);
            result.add("identity",identity==null?JsonNull.INSTANCE:new JsonPrimitive(identity));
            JsonElement observation=JsonNull.INSTANCE;
            if(identity!=null && target!=null && request.has("resource") && !request.get("resource").isJsonNull()) {
                String resource=request.get("resource").getAsString().toUpperCase(Locale.ROOT);
                if(!GrowthLedger.isGatherable(resource))return;
                Chest chest=(Chest)target.getState();Material material=Material.valueOf(resource);
                Map<UUID,Long> tracked=observers(identity);
                if(tracked.size()>=16 && !tracked.containsKey(player.getUniqueId())) { tracked.clear();resources.put(identity,new HashMap<>());epoch=UUID.randomUUID().toString(); }
                long revision=tracked.computeIfAbsent(player.getUniqueId(),ignored->0L);
                resources.computeIfAbsent(identity,ignored->new HashMap<>()).put(player.getUniqueId(),resource);
                JsonObject data=new JsonObject();data.addProperty("chestCount",count(chest.getInventory(),material));
                data.addProperty("playerCount",count(player.getInventory(),material));data.addProperty("revision",revision);data.addProperty("epoch",epoch);
                data.addProperty("uncontested",chest.getInventory().getViewers().stream().allMatch(viewer->viewer.getUniqueId().equals(player.getUniqueId())));
                observation=data;
            }
            result.add("observation",observation);
            player.sendPluginMessage(plugin,CHANNEL,result.toString().getBytes(StandardCharsets.UTF_8));
        } catch(RuntimeException invalid) { /* Invalid input never yields an identity. */ }
    }
}
