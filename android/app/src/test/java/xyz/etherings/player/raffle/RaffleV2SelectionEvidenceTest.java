package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RaffleV2SelectionEvidenceTest {
    private static final String ERT_REWARD = "11111111-1111-4111-8111-111111111111";
    private static final String ERU_REWARD = "22222222-2222-4222-8222-222222222222";
    private static final String RING_REWARD = "33333333-3333-4333-8333-333333333333";
    private static final String DRAW_RESULT = "44444444-4444-4444-8444-444444444444";

    @Test
    public void validatesExactPartitionWinnerAndEruFulfillmentAsImmutableEvidence() throws Exception {
        JSONObject selection = new JSONObject()
                .put("algorithm", "CSPRNG_UNBIASED_INT_V1")
                .put("ticket", "70").put("totalWeight", "100")
                .put("selectedSegmentIndex", 1)
                .put("ranges", new JSONArray()
                        .put(range(0, ERT_REWARD, "60", "0", "60"))
                        .put(range(1, ERU_REWARD, "40", "60", "100")));
        JSONObject reward = currencyReward(ERU_REWARD, "5 ERU", "ERU", 1, "40", "5", "5");
        JSONObject fulfillment = new JSONObject().put("type", "ERU_CREDIT")
                .put("ledgerTransactionId", "55555555-5555-4555-8555-555555555555")
                .put("balanceAfterExact", "105").put("balanceAfterDisplay", "105");

        RaffleV2SelectionEvidence evidence = RaffleV2SelectionEvidence.parse(
                selection, reward, fulfillment, DRAW_RESULT);

        assertEquals(70L, evidence.ticket());
        assertEquals(2, evidence.ranges().size());
        assertEquals(ERU_REWARD, evidence.ranges().get(1).rewardId());
        assertEquals(RaffleV2Reward.Type.ERU, evidence.reward().type());
        assertEquals("5.00", evidence.reward().amountDisplay());
        assertEquals(RaffleV2SelectionEvidence.Fulfillment.Type.ERU_CREDIT,
                evidence.fulfillment().type());
        assertEquals("105.00", evidence.fulfillment().balanceAfterDisplay());
        assertThrows(UnsupportedOperationException.class, () -> evidence.ranges().clear());
    }

    @Test
    public void validatesFractionalEruRewardAndFulfillmentDisplay() throws Exception {
        JSONObject selection = new JSONObject()
                .put("algorithm", "CSPRNG_UNBIASED_INT_V1")
                .put("ticket", "0").put("totalWeight", "100")
                .put("selectedSegmentIndex", 0)
                .put("ranges", new JSONArray().put(range(0, ERU_REWARD, "100", "0", "100")));
        JSONObject reward = currencyReward(
                ERU_REWARD, "Fractional ERU", "ERU", 0, "100", "0.125", "0.13"
        );
        JSONObject fulfillment = new JSONObject().put("type", "ERU_CREDIT")
                .put("ledgerTransactionId", "55555555-5555-4555-8555-555555555555")
                .put("balanceAfterExact", "99.999999999999999999")
                .put("balanceAfterDisplay", "100.00");

        RaffleV2SelectionEvidence evidence = RaffleV2SelectionEvidence.parse(
                selection, reward, fulfillment, DRAW_RESULT);

        assertEquals("0.125", evidence.reward().amountExact());
        assertEquals("0.13", evidence.reward().amountDisplay());
        assertEquals("99.999999999999999999", evidence.fulfillment().balanceAfterExact());
        assertEquals("100.00", evidence.fulfillment().balanceAfterDisplay());
    }

    @Test
    public void rejectsTicketWinnerAndRangeArithmeticDrift() throws Exception {
        JSONObject selection = new JSONObject()
                .put("algorithm", "CSPRNG_UNBIASED_INT_V1")
                .put("ticket", "60").put("totalWeight", "100")
                .put("selectedSegmentIndex", 0)
                .put("ranges", new JSONArray()
                        .put(range(0, ERT_REWARD, "60", "0", "60"))
                        .put(range(1, ERU_REWARD, "40", "60", "100")));
        JSONObject reward = currencyReward(ERT_REWARD, "5 ERT", "ERT", 0, "60", "5", "5.00");
        JSONObject fulfillment = new JSONObject().put("type", "ERT_CREDIT")
                .put("ledgerTransactionId", "55555555-5555-4555-8555-555555555555")
                .put("balanceAfterExact", "105").put("balanceAfterDisplay", "105.00");

        assertThrows(JSONException.class,
                () -> RaffleV2SelectionEvidence.parse(selection, reward, fulfillment, DRAW_RESULT));
        selection.put("selectedSegmentIndex", 1);
        selection.getJSONArray("ranges").getJSONObject(1).put("weight", "39");
        assertThrows(JSONException.class,
                () -> RaffleV2SelectionEvidence.parse(selection, reward, fulfillment, DRAW_RESULT));
    }

    @Test
    public void validatesCooperAwardIdentityAndStartingState() throws Exception {
        JSONObject selection = new JSONObject()
                .put("algorithm", "CSPRNG_UNBIASED_INT_V1")
                .put("ticket", "0").put("totalWeight", "1")
                .put("selectedSegmentIndex", 0)
                .put("ranges", new JSONArray().put(range(0, RING_REWARD, "1", "0", "1")));
        JSONObject reward = new JSONObject().put("rewardId", RING_REWARD)
                .put("code", "cooper").put("title", "Cooper Ring").put("type", "COPPER_RING")
                .put("segmentIndex", 0).put("weight", "1")
                .put("probability", new JSONObject().put("numerator", "1").put("denominator", "1"))
                .put("imageUrl", JSONObject.NULL).put("amountExact", JSONObject.NULL)
                .put("asset", new JSONObject().put("kind", "RING").put("rarity", "COPPER")
                        .put("displayRarity", "Cooper").put("quantity", 1));
        String ringId = "66666666-6666-4666-8666-666666666666";
        JSONObject ring = new JSONObject().put("id", ringId)
                .put("entitlementCode", "raffle-copper-v1:" + DRAW_RESULT)
                .put("kind", "COPPER").put("level", 1).put("shine", 100)
                .put("comfort", 2).put("charm", 7).put("quality", 20).put("luck", 12)
                .put("unspentAttributePoints", 0).put("visualVariantCode", "copper_rune_rough")
                .put("equipped", false);
        JSONObject fulfillment = new JSONObject().put("type", "RING_AWARD")
                .put("ringId", ringId)
                .put("ringEventId", "77777777-7777-4777-8777-777777777777")
                .put("equipped", false).put("ring", ring);

        RaffleV2SelectionEvidence evidence = RaffleV2SelectionEvidence.parse(
                selection, reward, fulfillment, DRAW_RESULT);

        assertEquals(RaffleV2SelectionEvidence.Fulfillment.Type.RING_AWARD,
                evidence.fulfillment().type());
        assertEquals(ringId, evidence.fulfillment().ringId());
        ring.put("entitlementCode", "raffle-copper-v1:wrong");
        assertThrows(JSONException.class,
                () -> RaffleV2SelectionEvidence.parse(selection, reward, fulfillment, DRAW_RESULT));
    }

    private static JSONObject range(int index, String rewardId, String weight,
            String start, String end) throws JSONException {
        return new JSONObject().put("segmentIndex", index).put("rewardId", rewardId)
                .put("weight", weight).put("startInclusive", start).put("endExclusive", end);
    }

    private static JSONObject currencyReward(String id, String title, String type, int index,
            String weight, String amount, String display) throws JSONException {
        return new JSONObject().put("rewardId", id).put("code", title.toLowerCase().replace(' ', '-'))
                .put("title", title).put("type", type).put("segmentIndex", index).put("weight", weight)
                .put("probability", new JSONObject().put("numerator", weight).put("denominator", "100"))
                .put("imageUrl", JSONObject.NULL).put("amountExact", amount).put("amountDisplay", display);
    }
}
