package companion.guard;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class DepositPolicyTest {
    @Test void chestContentsCanNeverBePickedUpOrSwappedEvenAfterConcurrentChange() {
        for(String action:new String[]{"PICKUP_ALL","PICKUP_HALF","SWAP_WITH_CURSOR","MOVE_TO_OTHER_INVENTORY","COLLECT_TO_CURSOR","HOTBAR_SWAP","DROP_ALL_SLOT"})
            assertFalse(DepositPolicy.allows(true,action,"OAK_LOG","STONE","OAK_LOG"));
        assertTrue(DepositPolicy.allows(true,"PLACE_ONE","OAK_LOG",null,"OAK_LOG"));
    }
    @Test void onlyRequestedPlayerInventoryLogsCanBePickedUpOrRestored() {
        assertTrue(DepositPolicy.allows(false,"PICKUP_ALL",null,"OAK_LOG","OAK_LOG"));
        assertTrue(DepositPolicy.allows(false,"PLACE_ALL","OAK_LOG",null,"OAK_LOG"));
        assertFalse(DepositPolicy.allows(false,"PICKUP_ALL",null,"DIAMOND","OAK_LOG"));
        assertFalse(DepositPolicy.allows(false,"PLACE_ALL","BIRCH_LOG",null,"OAK_LOG"));
        assertFalse(DepositPolicy.allows(false,"DROP_ALL_CURSOR","OAK_LOG",null,"OAK_LOG"));
    }
}
