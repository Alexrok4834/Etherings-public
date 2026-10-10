package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.HashSet;
import java.util.Set;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class CopperRingVisualCatalogTest {
    @Test
    public void mapsAllNineApprovedCodesToDistinctPackagedDrawables() {
        Set<Integer> drawables = new HashSet<>();
        assertEquals(9, CopperRingVisualCatalog.codes().size());

        for (String code : CopperRingVisualCatalog.codes()) {
            assertTrue(CopperRingVisualCatalog.supports(code));
            int drawable = CopperRingVisualCatalog.drawableFor(code);
            assertNotEquals(0, drawable);
            drawables.add(drawable);
        }

        assertEquals(9, drawables.size());
        assertFalse(CopperRingVisualCatalog.supports("copper_unknown"));
        assertEquals(0, CopperRingVisualCatalog.drawableFor("copper_unknown"));
    }

    @Test
    public void everyPackagedRingArtworkHasTransparentCorners() {
        for (String code : CopperRingVisualCatalog.codes()) {
            Bitmap bitmap = BitmapFactory.decodeResource(
                    RuntimeEnvironment.getApplication().getResources(),
                    CopperRingVisualCatalog.drawableFor(code)
            );

            assertEquals(1254, bitmap.getWidth());
            assertEquals(1254, bitmap.getHeight());
            assertEquals(code, 0, Color.alpha(bitmap.getPixel(0, 0)));
            assertEquals(code, 0, Color.alpha(bitmap.getPixel(bitmap.getWidth() - 1, 0)));
            assertEquals(code, 0, Color.alpha(bitmap.getPixel(0, bitmap.getHeight() - 1)));
            assertEquals(code, 0, Color.alpha(bitmap.getPixel(bitmap.getWidth() - 1, bitmap.getHeight() - 1)));
            bitmap.recycle();
        }
    }

    @Test
    public void modelRejectsUnknownVisualsAndContractVersions() throws Exception {
        JSONObject unknownVisual = CopperRingTest.ringJson(CopperRingTest.RING_ID, true)
                .put("visualVariantCode", "copper_unknown");
        JSONObject unknownVisualSet = CopperRingTest.ringJson(CopperRingTest.RING_ID, true)
                .put("visualSetVersion", "copper-visual-v2");
        JSONObject unknownRuleset = CopperRingTest.ringJson(CopperRingTest.RING_ID, true)
                .put("rulesetVersion", "copper-rules-v2");

        assertRejected(unknownVisual);
        assertRejected(unknownVisualSet);
        assertRejected(unknownRuleset);
    }

    private void assertRejected(JSONObject json) {
        try {
            CopperRing.fromJson(json);
        } catch (JSONException expected) {
            return;
        }
        throw new AssertionError("unsupported Copper visual contract must be rejected");
    }
}
