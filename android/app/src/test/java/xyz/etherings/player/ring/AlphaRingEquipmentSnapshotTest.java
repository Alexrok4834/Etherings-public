package xyz.etherings.player.ring;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class AlphaRingEquipmentSnapshotTest {
    private static final String COOPER = "e8ca2515-6bf8-4fab-8d3e-7a767c539822";

    @Test public void parsesAuthoritativeSelectionAndVersion() throws Exception {
        AlphaRingEquipmentSnapshot snapshot = AlphaRingEquipmentSnapshot.parse(new JSONObject()
                .put("selection", new JSONObject().put("kind", "COOPER").put("id", COOPER))
                .put("version", "1").put("eligibility", "ELIGIBLE")
                .put("effectsEnabled", true));
        assertTrue(snapshot.selection.matches("COOPER", COOPER));
        assertEquals("1", snapshot.version);
        assertTrue(snapshot.effectsEnabled);
    }

    @Test public void rejectsUnverifiedEffectsAndInvalidVersion() throws Exception {
        JSONObject body = new JSONObject()
                .put("selection", new JSONObject().put("kind", "SILVER_RING")
                        .put("id", "11111111111111111111111111111111"))
                .put("version", "2").put("eligibility", "UNKNOWN")
                .put("effectsEnabled", true);
        try {
            AlphaRingEquipmentSnapshot.parse(body);
            fail("UNKNOWN cannot enable effects");
        } catch (IllegalArgumentException expected) { }
        body.put("effectsEnabled", false).put("version", "0");
        try {
            AlphaRingEquipmentSnapshot.parse(body);
            fail("Version must be positive");
        } catch (IllegalArgumentException expected) { }
    }
}
