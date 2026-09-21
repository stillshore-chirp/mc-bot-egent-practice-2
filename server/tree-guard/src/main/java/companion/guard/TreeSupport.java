package companion.guard;

import java.util.Set;

/** Supports observed roots in soil or water without allowing adjacent building materials. */
final class TreeSupport {
    private static final Set<String> SOIL=Set.of("DIRT","GRASS_BLOCK","PODZOL","COARSE_DIRT","MYCELIUM","ROOTED_DIRT","MOSS_BLOCK","PALE_MOSS_BLOCK","MUD","MUDDY_MANGROVE_ROOTS","CRIMSON_NYLIUM","WARPED_NYLIUM");
    static boolean naturalSupport(String member,String neighbor,int dy) {
        boolean root=member.equals("MANGROVE_ROOTS") || member.equals("MUDDY_MANGROVE_ROOTS");
        if(neighbor.equals("WATER"))return root || member.equals("MANGROVE_LOG");
        return (root || dy==-1) && SOIL.contains(neighbor);
    }
}
