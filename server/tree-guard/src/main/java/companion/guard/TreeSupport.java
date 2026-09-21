package companion.guard;

import java.util.Set;

/** Supports observed roots in soil or water without allowing adjacent building materials. */
final class TreeSupport {
    private static final Set<String> SOIL=Set.of("DIRT","GRASS_BLOCK","PODZOL","COARSE_DIRT","MYCELIUM","ROOTED_DIRT","MOSS_BLOCK","PALE_MOSS_BLOCK","MUD","MUDDY_MANGROVE_ROOTS","CRIMSON_NYLIUM","WARPED_NYLIUM");
    static boolean naturalSupport(String member,String neighbor,int dx,int dy,int dz) {
        boolean root=member.equals("MANGROVE_ROOTS") || member.equals("MUDDY_MANGROVE_ROOTS");
        // 泥付き根は苗木の土台にはなるが、履歴外の根を周辺支持として認めない。
        if(neighbor.equals("MUDDY_MANGROVE_ROOTS"))
            return dx==0 && dy==-1 && dz==0 && (member.endsWith("_LOG") || member.endsWith("_STEM"));
        if(neighbor.equals("WATER"))return root || member.equals("MANGROVE_LOG");
        return (root || dy==-1) && SOIL.contains(neighbor);
    }
}
