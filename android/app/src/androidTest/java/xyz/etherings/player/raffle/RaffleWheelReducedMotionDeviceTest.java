package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import android.content.Context;
import android.provider.Settings;

import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class RaffleWheelReducedMotionDeviceTest {
    @Test
    public void disabledSystemAnimationsLandImmediatelyWithoutAnimator() throws Exception {
        RaffleWheelModel model = resultModel();
        AtomicInteger landings = new AtomicInteger();
        AtomicReference<RaffleWheelView> viewReference = new AtomicReference<>();
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(0.0f, Settings.Global.getFloat(context.getContentResolver(),
                Settings.Global.ANIMATOR_DURATION_SCALE, 1.0f), 0.0f);

        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            RaffleWheelView view = new RaffleWheelView(context);
            view.setOnLandingListener(landings::incrementAndGet);
            view.showResult(model, false);
            viewReference.set(view);
        });

        RaffleWheelView view = viewReference.get();
        assertFalse(view.hasRunningAnimatorForTest());
        assertEquals(280.0f, view.rotationDegreesForTest(), 0.001f);
        assertEquals(1, landings.get());
    }

    private static RaffleWheelModel resultModel() throws Exception {
        String ertId = "11111111-1111-4111-8111-111111111111";
        String eruId = "22222222-2222-4222-8222-222222222222";
        JSONObject ert = reward(ertId, "5 ERT", "ERT", 0, "60", "5", "5.00");
        JSONObject eru = reward(eruId, "5 ERU", "ERU", 1, "40", "5", "5");
        JSONObject selection = new JSONObject().put("algorithm", "CSPRNG_UNBIASED_INT_V1")
                .put("ticket", "70").put("totalWeight", "100").put("selectedSegmentIndex", 1)
                .put("ranges", new JSONArray()
                        .put(range(0, ertId, "60", "0", "60"))
                        .put(range(1, eruId, "40", "60", "100")));
        JSONObject fulfillment = new JSONObject().put("type", "ERU_CREDIT")
                .put("ledgerTransactionId", "44444444-4444-4444-8444-444444444444")
                .put("balanceAfterExact", "12").put("balanceAfterDisplay", "12");
        RaffleV2SelectionEvidence evidence = RaffleV2SelectionEvidence.parse(selection, eru,
                fulfillment, "33333333-3333-4333-8333-333333333333");
        return RaffleWheelModel.fromEvidence(evidence, Arrays.asList(
                RaffleV2Reward.fromJson(ert, 100), RaffleV2Reward.fromJson(eru, 100)));
    }

    private static JSONObject range(int index, String rewardId, String weight,
            String start, String end) throws Exception {
        return new JSONObject().put("segmentIndex", index).put("rewardId", rewardId)
                .put("weight", weight).put("startInclusive", start).put("endExclusive", end);
    }

    private static JSONObject reward(String id, String title, String type, int index,
            String weight, String amount, String display) throws Exception {
        return new JSONObject().put("rewardId", id).put("code", title.toLowerCase().replace(' ', '-'))
                .put("title", title).put("type", type).put("segmentIndex", index).put("weight", weight)
                .put("probability", new JSONObject().put("numerator", weight).put("denominator", "100"))
                .put("imageUrl", JSONObject.NULL).put("amountExact", amount).put("amountDisplay", display);
    }
}
