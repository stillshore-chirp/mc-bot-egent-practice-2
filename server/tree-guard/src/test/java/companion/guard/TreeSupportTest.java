package companion.guard;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class TreeSupportTest {
    @Test void observedMangroveRootsAllowSoilAndWaterButNotBuildingMaterials() {
        for(String root:new String[]{"MANGROVE_ROOTS","MUDDY_MANGROVE_ROOTS"}) {
            assertTrue(TreeSupport.naturalSupport(root,"DIRT",0));
            assertTrue(TreeSupport.naturalSupport(root,"MUD",1));
            assertTrue(TreeSupport.naturalSupport(root,"WATER",0));
            assertFalse(TreeSupport.naturalSupport(root,"STONE",0));
            assertFalse(TreeSupport.naturalSupport(root,"OAK_PLANKS",-1));
        }
    }
    @Test void allVanillaDirtTagSubstratesSupportObservedTreesOnlyFromBelow() {
        for(String soil:new String[]{"DIRT","GRASS_BLOCK","PODZOL","COARSE_DIRT","MYCELIUM","ROOTED_DIRT","MOSS_BLOCK","PALE_MOSS_BLOCK","MUD","MUDDY_MANGROVE_ROOTS"}) {
            assertTrue(TreeSupport.naturalSupport("OAK_LOG",soil,-1),soil);
            assertFalse(TreeSupport.naturalSupport("OAK_LOG",soil,0),soil);
            assertFalse(TreeSupport.naturalSupport("OAK_LOG",soil,1),soil);
        }
    }
    @Test void trunkSupportsRemainRestrictedToTheLayerBelow() {
        assertTrue(TreeSupport.naturalSupport("MANGROVE_LOG","WATER",0));
        assertFalse(TreeSupport.naturalSupport("OAK_LOG","WATER",0));
        assertTrue(TreeSupport.naturalSupport("OAK_LOG","DIRT",-1));
        assertFalse(TreeSupport.naturalSupport("OAK_LOG","DIRT",0));
    }
}
