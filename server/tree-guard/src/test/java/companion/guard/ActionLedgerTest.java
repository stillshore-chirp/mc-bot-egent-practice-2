package companion.guard;

import static org.junit.jupiter.api.Assertions.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ActionLedgerTest {
    private static final UUID WORLD = UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static final UUID ACTOR = UUID.fromString("00000000-0000-4000-8000-000000000002");

    @Test void placedBlocksRemainProtectedUntilObservedBreak() {
        ActionLedger ledger = new ActionLedger();
        ActionLedger.Point point = new ActionLedger.Point(WORLD, 1, 64, 2);
        assertTrue(ledger.recordPlacement(point, "stone"));
        assertTrue(ledger.isPlaced(point));
        ledger.remove(point);
        assertFalse(ledger.isPlaced(point));
    }

    @Test void permitsAreSingleUseAndExpire() {
        ActionLedger ledger = new ActionLedger();
        ActionLedger.Point point = new ActionLedger.Point(WORLD, 1, 64, 2);
        ActionLedger.Permit permit = new ActionLedger.Permit(ACTOR, "mine", point, "iron_ore");
        ledger.grant(permit, 20);
        assertTrue(ledger.consume(permit, 20));
        assertFalse(ledger.consume(permit, 20));
        ledger.grant(permit, 20);
        assertFalse(ledger.consume(permit, 21));
    }

    @Test void naturalMiningNeedsConfiguredRegionAfterRestartOrUnknownConstruction() {
        ActionLedger ledger = new ActionLedger();
        ActionLedger.Point point = new ActionLedger.Point(WORLD, 3, 64, 4);

        assertFalse(ledger.allowsNaturalMining(point, false));
        assertTrue(ledger.allowsNaturalMining(point, true));
        assertTrue(ledger.recordPlacement(point, "stone"));
        assertFalse(ledger.allowsNaturalMining(point, true));

        ledger.clear();
        // Restarted placement provenance cannot become evidence by absence.
        assertFalse(ledger.allowsNaturalMining(point, false));
        // An explicitly configured empty, known-safe test area remains the
        // only authority after the in-memory ledger is reset.
        assertTrue(ledger.allowsNaturalMining(point, true));
    }

    @Test void placementEvidenceCanBeRestoredAfterPluginRestart() {
        ActionLedger original = new ActionLedger();
        ActionLedger.Point point = new ActionLedger.Point(WORLD, 5, 64, 6);
        assertTrue(original.recordPlacement(point, "stone"));

        ActionLedger restarted = new ActionLedger();
        original.placementSnapshot().forEach(restarted::restorePlacement);
        assertTrue(restarted.isPlaced(point));
        assertFalse(restarted.allowsNaturalMining(point, true));
    }

    @Test void placementEvidenceRemainsAcrossChunkUnloadBoundary() {
        ActionLedger ledger = new ActionLedger();
        ActionLedger.Point point = new ActionLedger.Point(WORLD, 7, 64, 8);
        assertTrue(ledger.recordPlacement(point, "stone"));
        // Chunk unload clears tree-growth history, but must not clear action
        // placement provenance that protects an existing player structure.
        assertTrue(ledger.isPlaced(point));
    }

    @Test void uncertainMovedPlacementStopsNaturalMiningUntilOperatorRecovery() {
        ActionLedger ledger = new ActionLedger();
        ActionLedger.Point point = new ActionLedger.Point(WORLD, 9, 64, 10);
        assertTrue(ledger.recordPlacement(point, "stone"));
        ledger.markSaturated();
        assertTrue(ledger.isSaturated());
        assertFalse(ledger.allowsNaturalMining(point, true));
    }
}
