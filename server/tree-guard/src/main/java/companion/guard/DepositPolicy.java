package companion.guard;
import java.util.Set;
public final class DepositPolicy {
    private DepositPolicy() {}
    public static boolean allows(boolean containerSlot, String action, String cursor, String current, String resource) {
        if(resource==null || !GrowthLedger.isGatherable(resource))return false;
        if(cursor!=null && !cursor.equals(resource))return false;
        if(!containerSlot && current!=null && !current.equals(resource))return false;
        return containerSlot
            ? Set.of("PLACE_ALL","PLACE_SOME","PLACE_ONE","NOTHING").contains(action)
            : Set.of("PICKUP_ALL","PLACE_ALL","PLACE_SOME","PLACE_ONE","NOTHING").contains(action);
    }
}
