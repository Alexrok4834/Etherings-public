package xyz.etherings.player.raffle;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.economy.EruValue;
import xyz.etherings.player.ring.CopperRingVisualCatalog;

public final class RaffleV2SelectionEvidence {
    private static final long MAX_TOTAL_WEIGHT_EXCLUSIVE = 1L << 48;

    public static final class Range {
        private final int segmentIndex;
        private final String rewardId;
        private final long weight;
        private final long startInclusive;
        private final long endExclusive;

        private Range(int segmentIndex, String rewardId, long weight,
                long startInclusive, long endExclusive) {
            this.segmentIndex = segmentIndex;
            this.rewardId = rewardId;
            this.weight = weight;
            this.startInclusive = startInclusive;
            this.endExclusive = endExclusive;
        }

        public int segmentIndex() { return segmentIndex; }
        public String rewardId() { return rewardId; }
        public long weight() { return weight; }
        public long startInclusive() { return startInclusive; }
        public long endExclusive() { return endExclusive; }
    }

    public static final class Fulfillment {
        public enum Type { ERT_CREDIT, ERU_CREDIT, RING_AWARD }

        private final Type type;
        private final String ledgerTransactionId;
        private final String balanceAfterExact;
        private final String balanceAfterDisplay;
        private final String ringId;
        private final String ringEventId;
        private final String ringSnapshot;

        private Fulfillment(Type type, String ledgerTransactionId, String balanceAfterExact,
                String balanceAfterDisplay, String ringId, String ringEventId, String ringSnapshot) {
            this.type = type;
            this.ledgerTransactionId = ledgerTransactionId;
            this.balanceAfterExact = balanceAfterExact;
            this.balanceAfterDisplay = balanceAfterDisplay;
            this.ringId = ringId;
            this.ringEventId = ringEventId;
            this.ringSnapshot = ringSnapshot;
        }

        public Type type() { return type; }
        public String ledgerTransactionId() { return ledgerTransactionId; }
        public String balanceAfterExact() { return balanceAfterExact; }
        public String balanceAfterDisplay() { return balanceAfterDisplay; }
        public String ringId() { return ringId; }
        public String ringEventId() { return ringEventId; }
        public String ringSnapshot() { return ringSnapshot; }
    }

    private final String algorithm;
    private final long ticket;
    private final long totalWeight;
    private final int selectedSegmentIndex;
    private final List<Range> ranges;
    private final RaffleV2Reward reward;
    private final Fulfillment fulfillment;

    private RaffleV2SelectionEvidence(String algorithm, long ticket, long totalWeight,
            int selectedSegmentIndex, List<Range> ranges, RaffleV2Reward reward,
            Fulfillment fulfillment) {
        this.algorithm = algorithm;
        this.ticket = ticket;
        this.totalWeight = totalWeight;
        this.selectedSegmentIndex = selectedSegmentIndex;
        this.ranges = Collections.unmodifiableList(new ArrayList<>(ranges));
        this.reward = reward;
        this.fulfillment = fulfillment;
    }

    static RaffleV2SelectionEvidence parse(JSONObject selection, JSONObject rewardJson,
            JSONObject fulfillmentJson, String drawResultId) throws JSONException {
        String algorithm = RaffleV2Json.text(selection, "algorithm", 64);
        if (!"CSPRNG_UNBIASED_INT_V1".equals(algorithm)) {
            throw new JSONException("Unsupported Raffle selection algorithm");
        }
        long totalWeight = RaffleV2Json.positiveLongString(selection, "totalWeight");
        if (totalWeight >= MAX_TOTAL_WEIGHT_EXCLUSIVE) {
            throw new JSONException("Raffle total weight exceeds the random bound");
        }
        long ticket = nonNegativeLongString(selection, "ticket");
        if (ticket >= totalWeight) throw new JSONException("Raffle ticket is outside total weight");
        int selectedSegmentIndex = RaffleV2Json.nonNegativeInt(selection, "selectedSegmentIndex");

        JSONArray rangeJson = selection.getJSONArray("ranges");
        if (rangeJson.length() == 0 || rangeJson.length() > 1000) {
            throw new JSONException("Raffle ranges count is invalid");
        }
        List<Range> ranges = new ArrayList<>();
        long cursor = 0;
        Range winner = null;
        for (int index = 0; index < rangeJson.length(); index++) {
            JSONObject item = rangeJson.getJSONObject(index);
            int segmentIndex = RaffleV2Json.nonNegativeInt(item, "segmentIndex");
            if (segmentIndex != index) throw new JSONException("Raffle segments must be contiguous");
            String rewardId = RaffleV2Json.uuid(item, "rewardId");
            long weight = RaffleV2Json.positiveLongString(item, "weight");
            long start = nonNegativeLongString(item, "startInclusive");
            long end = RaffleV2Json.positiveLongString(item, "endExclusive");
            if (start != cursor || end <= start || end - start != weight || end > totalWeight) {
                throw new JSONException("Raffle selection ranges are not an exact partition");
            }
            Range range = new Range(segmentIndex, rewardId, weight, start, end);
            if (start <= ticket && ticket < end) {
                if (winner != null) throw new JSONException("Raffle ticket has multiple winners");
                winner = range;
            }
            ranges.add(range);
            cursor = end;
        }
        if (cursor != totalWeight || winner == null
                || winner.segmentIndex != selectedSegmentIndex) {
            throw new JSONException("Raffle winner does not match the selection evidence");
        }

        RaffleV2Reward reward = RaffleV2Reward.fromJson(rewardJson, totalWeight);
        if (reward.segmentIndex() != winner.segmentIndex
                || !reward.rewardId().equals(winner.rewardId)
                || reward.weight() != winner.weight) {
            throw new JSONException("Selected reward does not match its winning range");
        }
        Fulfillment fulfillment = parseFulfillment(fulfillmentJson, reward, drawResultId);
        return new RaffleV2SelectionEvidence(algorithm, ticket, totalWeight,
                selectedSegmentIndex, ranges, reward, fulfillment);
    }

    private static Fulfillment parseFulfillment(JSONObject json, RaffleV2Reward reward,
            String drawResultId) throws JSONException {
        String rawType = RaffleV2Json.text(json, "type", 32);
        if (reward.type() == RaffleV2Reward.Type.ERT) {
            if (!"ERT_CREDIT".equals(rawType)) throw new JSONException("ERT reward fulfillment is invalid");
            String transactionId = RaffleV2Json.uuid(json, "ledgerTransactionId");
            String exact = RaffleV2Json.text(json, "balanceAfterExact", 64);
            String display = RaffleV2Json.text(json, "balanceAfterDisplay", 64);
            try {
                ErtValue.fromExactAndDisplay(exact, display);
            } catch (IllegalArgumentException error) {
                throw new JSONException(error.getMessage());
            }
            return new Fulfillment(Fulfillment.Type.ERT_CREDIT, transactionId,
                    exact, display, null, null, null);
        }
        if (reward.type() == RaffleV2Reward.Type.ERU) {
            if (!"ERU_CREDIT".equals(rawType)) throw new JSONException("ERU reward fulfillment is invalid");
            String transactionId = RaffleV2Json.uuid(json, "ledgerTransactionId");
            String exact = RaffleV2Json.text(json, "balanceAfterExact", 64);
            String display = RaffleV2Json.text(json, "balanceAfterDisplay", 64);
            try {
                EruValue value = EruValue.fromExactAndDisplay(exact, display);
                display = value.display();
            } catch (IllegalArgumentException error) {
                throw new JSONException(error.getMessage());
            }
            return new Fulfillment(Fulfillment.Type.ERU_CREDIT, transactionId,
                    exact, display, null, null, null);
        }
        if (!"RING_AWARD".equals(rawType)) throw new JSONException("Cooper reward fulfillment is invalid");
        String ringId = RaffleV2Json.uuid(json, "ringId");
        String eventId = RaffleV2Json.uuid(json, "ringEventId");
        if (strictBoolean(json, "equipped")) throw new JSONException("Awarded Cooper must be unequipped");
        JSONObject ring = json.getJSONObject("ring");
        if (!ringId.equals(RaffleV2Json.uuid(ring, "id"))
                || !("raffle-copper-v1:" + drawResultId).equals(
                        RaffleV2Json.text(ring, "entitlementCode", 128))
                || !"COPPER".equals(RaffleV2Json.text(ring, "kind", 16))
                || strictInt(ring, "level") != 1
                || strictInt(ring, "shine") != 100
                || strictInt(ring, "unspentAttributePoints") != 0
                || strictBoolean(ring, "equipped")) {
            throw new JSONException("Awarded Cooper identity is invalid");
        }
        for (String attribute : new String[]{"comfort", "charm", "quality", "luck"}) {
            int value = strictInt(ring, attribute);
            if (value < 2 || value > 20) throw new JSONException("Awarded Cooper attributes are invalid");
        }
        String variant = RaffleV2Json.text(ring, "visualVariantCode", 64);
        if (!CopperRingVisualCatalog.supports(variant)) {
            throw new JSONException("Awarded Cooper visual variant is unsupported");
        }
        return new Fulfillment(Fulfillment.Type.RING_AWARD, null, null, null,
                ringId, eventId, ring.toString());
    }

    private static long nonNegativeLongString(JSONObject json, String key) throws JSONException {
        Object raw = json.get(key);
        if (!(raw instanceof String) || !((String) raw).matches("(?:0|[1-9][0-9]*)")) {
            throw new JSONException(key + " must be a canonical non-negative integer string");
        }
        try {
            BigInteger value = new BigInteger((String) raw);
            if (value.bitLength() > 63) throw new ArithmeticException();
            return value.longValue();
        } catch (ArithmeticException error) {
            throw new JSONException(key + " exceeds the Android geometry range");
        }
    }

    private static int strictInt(JSONObject json, String key) throws JSONException {
        Object raw = json.get(key);
        if (!(raw instanceof Integer)) throw new JSONException(key + " must be an integer");
        return (Integer) raw;
    }

    private static boolean strictBoolean(JSONObject json, String key) throws JSONException {
        Object raw = json.get(key);
        if (!(raw instanceof Boolean)) throw new JSONException(key + " must be a boolean");
        return (Boolean) raw;
    }

    public String algorithm() { return algorithm; }
    public long ticket() { return ticket; }
    public long totalWeight() { return totalWeight; }
    public int selectedSegmentIndex() { return selectedSegmentIndex; }
    public List<Range> ranges() { return ranges; }
    public RaffleV2Reward reward() { return reward; }
    public Fulfillment fulfillment() { return fulfillment; }
}
