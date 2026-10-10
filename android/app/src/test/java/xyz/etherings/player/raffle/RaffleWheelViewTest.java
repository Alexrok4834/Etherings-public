package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.provider.Settings;
import android.view.View;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;

import xyz.etherings.player.R;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class RaffleWheelViewTest {
    private static final String ERT_ID = "11111111-1111-4111-8111-111111111111";
    private static final String ERU_ID = "22222222-2222-4222-8222-222222222222";
    private static final String DRAW_RESULT = "33333333-3333-4333-8333-333333333333";

    private RaffleV2SelectionEvidence evidence;
    private RaffleWheelModel model;
    private RaffleV2Draw currentDraw;

    @Before
    public void setUp() throws Exception {
        JSONObject ert = reward(ERT_ID, "5 ERT", "ERT", 0, "60", "5", "5.00");
        JSONObject eru = reward(ERU_ID, "5 ERU", "ERU", 1, "40", "5", "5");
        JSONObject selection = new JSONObject().put("algorithm", "CSPRNG_UNBIASED_INT_V1")
                .put("ticket", "70").put("totalWeight", "100").put("selectedSegmentIndex", 1)
                .put("ranges", new JSONArray()
                        .put(range(0, ERT_ID, "60", "0", "60"))
                        .put(range(1, ERU_ID, "40", "60", "100")));
        JSONObject fulfillment = new JSONObject().put("type", "ERU_CREDIT")
                .put("ledgerTransactionId", "44444444-4444-4444-8444-444444444444")
                .put("balanceAfterExact", "12").put("balanceAfterDisplay", "12");
        evidence = RaffleV2SelectionEvidence.parse(selection, eru, fulfillment, DRAW_RESULT);
        model = RaffleWheelModel.fromEvidence(evidence, Arrays.asList(
                RaffleV2Reward.fromJson(ert, 100), RaffleV2Reward.fromJson(eru, 100)));
        currentDraw = RaffleV2Draw.fromJson(new JSONObject()
                .put("contractVersion", "raffle-v2")
                .put("serverTime", "2026-09-01T12:00:00Z")
                .put("draw", new JSONObject()
                        .put("drawId", "55555555-5555-4555-8555-555555555555")
                        .put("configurationVersion", "66666666-6666-4666-8666-666666666666")
                        .put("title", "Daily Draw").put("description", JSONObject.NULL)
                        .put("cost", new JSONObject().put("currency", "ERT")
                                .put("amountExact", "5").put("amountDisplay", "5.00"))
                        .put("attempts", new JSONObject().put("limit", 5).put("used", 1)
                                .put("remaining", 4).put("day", "2026-09-01")
                                .put("resetsAt", "2026-09-02T00:00:00Z"))
                        .put("totalWeight", "100")
                        .put("rewards", new JSONArray().put(ert).put(eru))));
    }

    @Test
    public void preservesExactServerGeometryAndUsesApprovedArtworkLanding() {
        assertEquals(2, model.segments().size());
        assertEquals(60L, model.segments().get(0).weight());
        assertEquals(60L, model.segments().get(1).startInclusive());
        assertEquals("5 ERU", model.selectedSegment().title());
        assertEquals(2080.0f, RaffleWheelMotion.landingRotationDegrees(model), 0.001f);
        assertEquals(280.0f, RaffleWheelMotion.normalizedDegrees(
                RaffleWheelMotion.landingRotationDegrees(model)), 0.001f);
        assertThrows(UnsupportedOperationException.class, () -> model.segments().clear());
    }

    @Test
    public void measuresSquareAndReducedMotionLandsWithoutAnimator() {
        Context context = ApplicationProvider.getApplicationContext();
        RaffleWheelView view = new RaffleWheelView(context);
        view.measure(View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(700, View.MeasureSpec.EXACTLY));
        assertEquals(480, view.getMeasuredWidth());
        assertEquals(480, view.getMeasuredHeight());

        view.layout(0, 0, 480, 480);
        view.showResult(model, true);

        assertFalse(view.hasRunningAnimatorForTest());
        assertEquals(280.0f, view.rotationDegreesForTest(), 0.001f);
        assertEquals("Raffle result: 5 ERU", view.getContentDescription().toString());
    }

    @Test
    public void reducedMotionReportsLandingExactlyOnce() {
        Context context = ApplicationProvider.getApplicationContext();
        RaffleWheelView view = new RaffleWheelView(context);
        AtomicInteger landings = new AtomicInteger();
        view.setOnLandingListener(landings::incrementAndGet);

        view.showResult(model, true);

        assertEquals(1, landings.get());
        view.clear();
        assertEquals(1, landings.get());
    }

    @Test
    public void disabledSystemAnimatorScaleLandsWithoutAnimator() {
        Context context = ApplicationProvider.getApplicationContext();
        float originalScale = Settings.Global.getFloat(context.getContentResolver(),
                Settings.Global.ANIMATOR_DURATION_SCALE, 1.0f);
        try {
            Settings.Global.putFloat(context.getContentResolver(),
                    Settings.Global.ANIMATOR_DURATION_SCALE, 0.0f);
            RaffleWheelView view = new RaffleWheelView(context);
            AtomicInteger landings = new AtomicInteger();
            view.setOnLandingListener(landings::incrementAndGet);

            view.showResult(model, false);

            assertFalse(view.hasRunningAnimatorForTest());
            assertEquals(280.0f, view.rotationDegreesForTest(), 0.001f);
            assertEquals(1, landings.get());
        } finally {
            Settings.Global.putFloat(context.getContentResolver(),
                    Settings.Global.ANIMATOR_DURATION_SCALE, originalScale);
        }
    }

    @Test
    public void readyWheelShowsExactCurrentGeometryWithoutSelectingResult() {
        Context context = ApplicationProvider.getApplicationContext();
        RaffleWheelModel ready = RaffleWheelModel.fromCurrent(currentDraw);
        RaffleWheelView view = new RaffleWheelView(context);

        view.showReady(ready);

        assertEquals(-1, ready.selectedSegmentIndex());
        assertEquals(60L, ready.segments().get(0).endExclusive());
        assertEquals(100L, ready.segments().get(1).endExclusive());
        assertEquals("Raffle wheel with current reward chances",
                view.getContentDescription().toString());
        assertThrows(IllegalStateException.class, ready::selectedSegment);
    }

    @Test
    public void rendersNonBlankArtworkAndPointerWithoutAnimatingWaitingInReducedMode() {
        Context context = ApplicationProvider.getApplicationContext();
        RaffleWheelView view = new RaffleWheelView(context);
        view.measure(View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, 480, 480);
        view.showResult(model, true);
        Bitmap bitmap = Bitmap.createBitmap(480, 480, Bitmap.Config.ARGB_8888);
        view.draw(new Canvas(bitmap));

        int painted = 0;
        for (int y = 0; y < bitmap.getHeight(); y += 4) {
            for (int x = 0; x < bitmap.getWidth(); x += 4) {
                if ((bitmap.getPixel(x, y) >>> 24) != 0) painted++;
            }
        }
        assertTrue(painted > 500);
        assertTrue((bitmap.getPixel(240, 180) >>> 24) != 0);

        view.showWaiting(true);
        assertFalse(view.hasRunningAnimatorForTest());
        assertEquals("Raffle draw in progress", view.getContentDescription().toString());
    }

    @Test
    public void approvedArtworkHasStableTransparentSquareCanvas() {
        Context context = ApplicationProvider.getApplicationContext();
        Bitmap bitmap = BitmapFactory.decodeResource(context.getResources(), R.drawable.raffle_wheel);

        assertEquals(1254, bitmap.getWidth());
        assertEquals(1254, bitmap.getHeight());
        assertTrue(Color.alpha(bitmap.getPixel(0, 0)) <= 1);
        assertTrue(Color.alpha(bitmap.getPixel(bitmap.getWidth() - 1, 0)) <= 1);
        assertTrue(Color.alpha(bitmap.getPixel(0, bitmap.getHeight() - 1)) <= 1);
        assertTrue(Color.alpha(bitmap.getPixel(bitmap.getWidth() - 1,
                bitmap.getHeight() - 1)) <= 1);
        assertTrue(Color.alpha(bitmap.getPixel(bitmap.getWidth() / 2,
                bitmap.getHeight() / 2)) >= 252);
        bitmap.recycle();
    }

    @Test
    public void mapsCanonicalRewardsToFixedArtworkSectors() {
        assertEquals(40.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.ERT, "5"), 0.001f);
        assertEquals(120.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.ERT, "10"), 0.001f);
        assertEquals(200.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.ERT, "20"), 0.001f);
        assertEquals(280.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.ERT, "50"), 0.001f);
        assertEquals(0.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.ERU, "1"), 0.001f);
        assertEquals(80.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.ERU, "5"), 0.001f);
        assertEquals(160.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.ERU, "10"), 0.001f);
        assertEquals(240.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.ERU, "30"), 0.001f);
        assertEquals(320.0f, RaffleWheelMotion.artworkCenterDegrees(
                RaffleV2Reward.Type.COPPER_RING, null), 0.001f);
        assertThrows(IllegalArgumentException.class, () ->
                RaffleWheelMotion.artworkCenterDegrees(RaffleV2Reward.Type.ERT, "1"));
    }

    private static JSONObject range(int index, String rewardId, String weight,
            String start, String end) throws JSONException {
        return new JSONObject().put("segmentIndex", index).put("rewardId", rewardId)
                .put("weight", weight).put("startInclusive", start).put("endExclusive", end);
    }

    private static JSONObject reward(String id, String title, String type, int index,
            String weight, String amount, String display) throws JSONException {
        return new JSONObject().put("rewardId", id).put("code", title.toLowerCase().replace(' ', '-'))
                .put("title", title).put("type", type).put("segmentIndex", index).put("weight", weight)
                .put("probability", new JSONObject().put("numerator", weight).put("denominator", "100"))
                .put("imageUrl", JSONObject.NULL).put("amountExact", amount).put("amountDisplay", display);
    }
}
