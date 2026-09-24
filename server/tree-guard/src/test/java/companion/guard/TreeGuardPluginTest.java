package companion.guard;

import static org.junit.jupiter.api.Assertions.*;
import java.util.List;
import org.bukkit.configuration.file.YamlConfiguration;
import org.junit.jupiter.api.Test;

class TreeGuardPluginTest {
    @Test void legacyBotActionGuardDefaultsToDisabled() {
        YamlConfiguration config = new YamlConfiguration();

        assertFalse(TreeGuardPlugin.legacyActionGuardEnabled(config));
        assertFalse(TreeGuardPlugin.shouldEnforceLegacyActionGuard(
            TreeGuardPlugin.legacyActionGuardEnabled(config), true));
    }

    @Test void legacyBotActionGuardRequiresExplicitEnablementAndConfiguredBot() {
        YamlConfiguration config = new YamlConfiguration();
        config.set("legacy-bot-action-guard.enabled", true);

        assertTrue(TreeGuardPlugin.legacyActionGuardEnabled(config));
        assertTrue(TreeGuardPlugin.shouldEnforceLegacyActionGuard(true, true));
        assertFalse(TreeGuardPlugin.shouldEnforceLegacyActionGuard(true, false));
        assertFalse(TreeGuardPlugin.shouldEnforceLegacyActionGuard(false, true));
    }

    @Test void emptyOrMalformedLedgerCannotPassSchemaValidation() {
        YamlConfiguration empty = new YamlConfiguration();
        assertFalse(TreeGuardPlugin.validActionLedgerSchema(empty));

        YamlConfiguration malformed = new YamlConfiguration();
        malformed.set("schema-version", 1);
        malformed.set("placements", "not-a-list");
        malformed.set("saturated", false);
        assertFalse(TreeGuardPlugin.validActionLedgerSchema(malformed));

        YamlConfiguration valid = new YamlConfiguration();
        valid.set("schema-version", 1);
        valid.set("placements", List.of());
        valid.set("saturated", false);
        assertTrue(TreeGuardPlugin.validActionLedgerSchema(valid));
    }
}
