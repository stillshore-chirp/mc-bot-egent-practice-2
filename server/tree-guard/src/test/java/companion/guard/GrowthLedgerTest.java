package companion.guard;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
class GrowthLedgerTest {
    final UUID world=UUID.randomUUID();
    final GrowthLedger.Point root=new GrowthLedger.Point(world,0,64,0);
    final GrowthLedger.Point top=new GrowthLedger.Point(world,0,65,0);
    @Test void netherStemsAreRecognizedWithoutAllowingPlacedOrStrippedWood() {
        assertTrue(GrowthLedger.isGatherable("CRIMSON_STEM"));
        assertTrue(GrowthLedger.isGatherable("WARPED_STEM"));
        assertFalse(GrowthLedger.isGatherable("STRIPPED_OAK_LOG"));
        GrowthLedger ledger=new GrowthLedger();
        assertEquals("unknown",ledger.decision(root,"crimson_stem",false,true));
        ledger.grew(Map.of(root,"crimson_stem"));
        assertEquals("allowed",ledger.decision(root,"crimson_stem",false,true));
    }
    @Test void onlyGrowthRecordedMangroveRootsSupportTheTree() {
        GrowthLedger ledger=new GrowthLedger();
        assertFalse(ledger.known(root,"mangrove_roots"));
        ledger.grew(Map.of(root,"mangrove_roots",top,"mangrove_log"));
        assertTrue(ledger.known(root,"mangrove_roots"));
        assertFalse(GrowthLedger.isGatherable("MANGROVE_ROOTS"));
        ledger.changedNear(root);
        assertFalse(ledger.known(root,"mangrove_roots"));
        assertEquals("unknown",ledger.decision(top,"mangrove_log",false,true));
    }
    @Test void observedRootCoverSharesTheTreeInvalidationBoundary() {
        GrowthLedger ledger=new GrowthLedger();
        GrowthLedger.Point cover=new GrowthLedger.Point(world,2,65,0);
        assertFalse(ledger.known(cover,"moss_carpet"));
        GrowthLedger.Point propagule=new GrowthLedger.Point(world,0,67,0);
        ledger.grew(Map.of(root,"mangrove_roots",top,"mangrove_log",cover,"moss_carpet",propagule,"mangrove_propagule"));
        assertTrue(ledger.known(propagule,"mangrove_propagule"));
        assertTrue(ledger.known(cover,"moss_carpet"));
        assertFalse(GrowthLedger.isGatherable("MOSS_CARPET"));
        ledger.changedNear(new GrowthLedger.Point(world,3,65,0));
        assertEquals("unknown",ledger.decision(top,"mangrove_log",false,true));
    }
    @Test void unknownHistoryAndDifferentWorldAreDenied() {
        GrowthLedger ledger=new GrowthLedger();
        assertEquals("unknown",ledger.decision(root,"oak_log",false,true));
        ledger.grew(Map.of(root,"oak_log"));
        assertEquals("unknown",ledger.decision(new GrowthLedger.Point(UUID.randomUUID(),0,64,0),"oak_log",false,true));
    }
    @Test void growthRequiresCurrentBlockAndSafeSurroundings() {
        GrowthLedger ledger=new GrowthLedger();ledger.grew(Map.of(root,"oak_log"));
        assertEquals("allowed",ledger.decision(root,"oak_log",false,true));
        assertEquals("changed",ledger.decision(root,"birch_log",false,true));
        assertEquals("protected",ledger.decision(root,"oak_log",true,true));
        assertEquals("protected",ledger.decision(root,"oak_log",false,false));
    }
    @Test void placementNearOneLogInvalidatesWholeTree() {
        GrowthLedger ledger=new GrowthLedger();ledger.grew(Map.of(root,"oak_log",top,"oak_log"));
        ledger.changedNear(new GrowthLedger.Point(world,1,64,0));
        assertEquals("unknown",ledger.decision(top,"oak_log",false,true));
    }
    @Test void invalidationUsesOriginalFootprintAfterPartialHarvestAndLeavesOtherTrees() {
        GrowthLedger ledger=new GrowthLedger();
        GrowthLedger.Point high=new GrowthLedger.Point(world,0,68,0),other=new GrowthLedger.Point(world,20,64,0);
        ledger.grew(Map.of(root,"oak_log",high,"oak_log"));ledger.grew(Map.of(other,"birch_log"));
        ledger.harvested(root);ledger.changedNear(root);
        assertEquals("unknown",ledger.decision(high,"oak_log",false,true));
        assertEquals("allowed",ledger.decision(other,"birch_log",false,true));
    }
    @Test void botNonLogBreakInvalidatesNearbyTreeWhileRecordedHarvestPreservesRemainder() {
        GrowthLedger ledger=new GrowthLedger();
        ledger.grew(Map.of(root,"oak_log",top,"oak_log"));
        ledger.broken(root,"oak_log",true);
        assertEquals("allowed",ledger.decision(top,"oak_log",false,true));
        ledger.broken(new GrowthLedger.Point(world,1,65,0),"stone",true);
        assertEquals("unknown",ledger.decision(top,"oak_log",false,true));
        ledger.grew(Map.of(root,"oak_log",top,"oak_log"));
        ledger.broken(root,"oak_log",false);
        assertEquals("unknown",ledger.decision(top,"oak_log",false,true));
    }
    @Test void batchChangesInvalidateAffectedFootprintsAndPreserveUnrelatedTrees() {
        GrowthLedger ledger=new GrowthLedger();
        GrowthLedger.Point far=new GrowthLedger.Point(world,20,64,0);
        ledger.grew(Map.of(root,"oak_log",top,"oak_log"));ledger.grew(Map.of(far,"birch_log"));
        List<GrowthLedger.Point> changes=new ArrayList<>();
        for(int x=100;x<1100;x++)changes.add(new GrowthLedger.Point(world,x,64,0));
        changes.add(new GrowthLedger.Point(world,1,64,0));
        ledger.changedNear(changes);
        assertEquals("unknown",ledger.decision(top,"oak_log",false,true));
        assertEquals("allowed",ledger.decision(far,"birch_log",false,true));
        ledger.changedNear(Collections.nCopies(10_001,root));
        assertEquals("unknown",ledger.decision(far,"birch_log",false,true));
    }
    @Test void HarvestAllowsRemainingTreeButCannotRecountRemovedLog() {
        GrowthLedger ledger=new GrowthLedger();ledger.grew(Map.of(root,"oak_log",top,"oak_log"));ledger.harvested(root);
        assertEquals("unknown",ledger.decision(root,"oak_log",false,true));
        assertEquals("allowed",ledger.decision(top,"oak_log",false,true));
        ledger.clear();assertEquals("unknown",ledger.decision(top,"oak_log",false,true));
    }
}
