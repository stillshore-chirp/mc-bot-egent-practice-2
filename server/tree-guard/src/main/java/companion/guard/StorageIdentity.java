package companion.guard;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Predicate;
import org.bukkit.*;
import org.bukkit.block.*;
import org.bukkit.entity.Player;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.PluginMessageListener;

/** Identifies explicitly nominated containers; never transfers any inventory. */
public final class StorageIdentity implements PluginMessageListener {
    public static final String CHANNEL="companion:storage";
    private final JavaPlugin plugin;
    private final Predicate<Player> authorized;
    private final NamespacedKey identityKey;
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
            String identity=null;
            if(operation.equals("inspect") || operation.equals("register")) {
                JsonObject p=request.getAsJsonObject("position");
                int x=Integer.parseInt(p.get("x").getAsString()),y=Integer.parseInt(p.get("y").getAsString()),z=Integer.parseInt(p.get("z").getAsString());
                World world=player.getWorld();boolean register=operation.equals("register");
                if(Math.abs((long)x)>30_000_000 || Math.abs((long)z)>30_000_000 || y<world.getMinHeight() || y>=world.getMaxHeight())return;
                if(world.isChunkLoaded(x>>4,z>>4) && player.getLocation().distanceSquared(new Location(world,x,y,z))<=(register?25:128*128)) identity=identity(world.getBlockAt(x,y,z),register);
            } else if(!operation.equals("world"))return;
            JsonObject result=new JsonObject();result.addProperty("id",id);result.addProperty("worldId",player.getWorld().getUID().toString());
            result.add("identity",identity==null?JsonNull.INSTANCE:new JsonPrimitive(identity));
            player.sendPluginMessage(plugin,CHANNEL,result.toString().getBytes(StandardCharsets.UTF_8));
        } catch(RuntimeException invalid) { /* Invalid input never yields an identity. */ }
    }
}
