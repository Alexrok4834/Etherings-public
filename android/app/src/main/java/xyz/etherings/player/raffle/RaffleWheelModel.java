package xyz.etherings.player.raffle;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class RaffleWheelModel {
    public static final class Segment {
        private final int segmentIndex;
        private final String rewardId;
        private final String title;
        private final RaffleV2Reward.Type type;
        private final String amountExact;
        private final long weight;
        private final long startInclusive;
        private final long endExclusive;

        private Segment(int segmentIndex, String rewardId, String title,
                RaffleV2Reward.Type type, String amountExact, long weight,
                long startInclusive, long endExclusive) {
            this.segmentIndex = segmentIndex;
            this.rewardId = rewardId;
            this.title = title;
            this.type = type;
            this.amountExact = amountExact;
            this.weight = weight;
            this.startInclusive = startInclusive;
            this.endExclusive = endExclusive;
        }

        public int segmentIndex() { return segmentIndex; }
        public String rewardId() { return rewardId; }
        public String title() { return title; }
        public RaffleV2Reward.Type type() { return type; }
        public String amountExact() { return amountExact; }
        public long weight() { return weight; }
        public long startInclusive() { return startInclusive; }
        public long endExclusive() { return endExclusive; }
    }

    private final List<Segment> segments;
    private final long totalWeight;
    private final int selectedSegmentIndex;

    private RaffleWheelModel(List<Segment> segments, long totalWeight, int selectedSegmentIndex) {
        this.segments = Collections.unmodifiableList(new ArrayList<>(segments));
        this.totalWeight = totalWeight;
        this.selectedSegmentIndex = selectedSegmentIndex;
    }

    public static RaffleWheelModel fromEvidence(RaffleV2SelectionEvidence evidence,
            List<RaffleV2Reward> knownRewards) {
        if (evidence == null) throw new IllegalArgumentException("evidence is required");
        Map<String, RaffleV2Reward> catalog = new HashMap<>();
        if (knownRewards != null) {
            for (RaffleV2Reward reward : knownRewards) {
                if (reward != null) catalog.put(reward.rewardId(), reward);
            }
        }
        List<Segment> segments = new ArrayList<>();
        for (RaffleV2SelectionEvidence.Range range : evidence.ranges()) {
            RaffleV2Reward reward = catalog.get(range.rewardId());
            if (range.segmentIndex() == evidence.selectedSegmentIndex()) reward = evidence.reward();
            if (reward != null && (reward.segmentIndex() != range.segmentIndex()
                    || reward.weight() != range.weight()
                    || !reward.rewardId().equals(range.rewardId()))) {
                throw new IllegalArgumentException("reward catalog does not match selection evidence");
            }
            String title = reward == null ? null : reward.title();
            RaffleV2Reward.Type type = reward == null ? null : reward.type();
            String amountExact = reward == null ? null : reward.amountExact();
            segments.add(new Segment(range.segmentIndex(), range.rewardId(), title, type, amountExact,
                    range.weight(), range.startInclusive(), range.endExclusive()));
        }
        return new RaffleWheelModel(segments, evidence.totalWeight(), evidence.selectedSegmentIndex());
    }

    public static RaffleWheelModel fromCurrent(RaffleV2Draw draw) {
        if (draw == null || draw.rewards().isEmpty()) {
            throw new IllegalArgumentException("current Draw is required");
        }
        List<Segment> segments = new ArrayList<>();
        long start = 0L;
        for (RaffleV2Reward reward : draw.rewards()) {
            long end;
            try {
                end = Math.addExact(start, reward.weight());
            } catch (ArithmeticException error) {
                throw new IllegalArgumentException("reward geometry overflow", error);
            }
            segments.add(new Segment(reward.segmentIndex(), reward.rewardId(), reward.title(),
                    reward.type(), reward.amountExact(), reward.weight(), start, end));
            start = end;
        }
        if (start != draw.totalWeight()) {
            throw new IllegalArgumentException("reward geometry does not match total weight");
        }
        return new RaffleWheelModel(segments, draw.totalWeight(), -1);
    }

    public List<Segment> segments() { return segments; }
    public long totalWeight() { return totalWeight; }
    public int selectedSegmentIndex() { return selectedSegmentIndex; }

    public Segment selectedSegment() {
        if (selectedSegmentIndex < 0) throw new IllegalStateException("wheel has no selected result");
        for (Segment segment : segments) {
            if (segment.segmentIndex == selectedSegmentIndex) return segment;
        }
        throw new IllegalStateException("selected segment is missing");
    }
}
