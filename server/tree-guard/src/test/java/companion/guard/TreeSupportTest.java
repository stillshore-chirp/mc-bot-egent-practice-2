package companion.guard;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class TreeSupportTest {
    @Test void observedMangroveRootsAllowSoilAndWaterButNotBuildingMaterials() {
        for(String root:new String[]{"MANGROVE_ROOTS","MUDDY_MANGROVE_ROOTS"}) {
            assertTrue(TreeSupport.naturalSupport(root,"DIRT",0,0,0));
            assertTrue(TreeSupport.naturalSupport(root,"MUD",0,1,0));
            assertTrue(TreeSupport.naturalSupport(root,"WATER",0,0,0));
            assertFalse(TreeSupport.naturalSupport(root,"STONE",0,0,0));
            assertFalse(TreeSupport.naturalSupport(root,"OAK_PLANKS",0,-1,0));
        }
    }
    @Test void allVanillaDirtTagSubstratesSupportObservedTreesOnlyFromBelow() {
        for(String soil:new String[]{"DIRT","GRASS_BLOCK","PODZOL","COARSE_DIRT","MYCELIUM","ROOTED_DIRT","MOSS_BLOCK","PALE_MOSS_BLOCK","MUD","MUDDY_MANGROVE_ROOTS"}) {
            assertTrue(TreeSupport.naturalSupport("OAK_LOG",soil,0,-1,0),soil);
            assertFalse(TreeSupport.naturalSupport("OAK_LOG",soil,0,0,0),soil);
            assertFalse(TreeSupport.naturalSupport("OAK_LOG",soil,0,1,0),soil);
        }
    }
    @Test void unrecordedMuddyRootsAreOnlyAllowedAsTrunkSubstrates() {
        for(String root:new String[]{"MANGROVE_ROOTS","MUDDY_MANGROVE_ROOTS"})
            for(int dy:new int[]{-1,0,1})
                assertFalse(TreeSupport.naturalSupport(root,"MUDDY_MANGROVE_ROOTS",0,dy,0));
        assertTrue(TreeSupport.naturalSupport("MANGROVE_LOG","MUDDY_MANGROVE_ROOTS",0,-1,0));
        for(int dx=-1;dx<=1;dx++) for(int dz=-1;dz<=1;dz++)
            assertEquals(dx==0 && dz==0,TreeSupport.naturalSupport("MANGROVE_LOG","MUDDY_MANGROVE_ROOTS",dx,-1,dz));
        assertFalse(TreeSupport.naturalSupport("MOSS_CARPET","MUDDY_MANGROVE_ROOTS",0,-1,0));
    }
    @Test void trunkSupportsRemainRestrictedToTheLayerBelow() {
        assertTrue(TreeSupport.naturalSupport("MANGROVE_LOG","WATER",0,0,0));
        assertFalse(TreeSupport.naturalSupport("OAK_LOG","WATER",0,0,0));
        assertTrue(TreeSupport.naturalSupport("OAK_LOG","DIRT",0,-1,0));
        assertFalse(TreeSupport.naturalSupport("OAK_LOG","DIRT",0,0,0));
    }
}
