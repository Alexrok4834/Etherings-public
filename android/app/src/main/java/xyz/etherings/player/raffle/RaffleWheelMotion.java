package xyz.etherings.player.raffle;

final class RaffleWheelMotion {
    static final int FULL_TURNS = 5;

    private RaffleWheelMotion() {}

    static float landingRotationDegrees(RaffleWheelModel model) {
        RaffleWheelModel.Segment winner = model.selectedSegment();
        double centerDegrees = artworkCenterDegrees(winner.type(), winner.amountExact());
        double landingOffset = (360.0d - centerDegrees) % 360.0d;
        return (float) (FULL_TURNS * 360.0d + landingOffset);
    }

    static float artworkCenterDegrees(RaffleV2Reward.Type type, String amountExact) {
        if (type == RaffleV2Reward.Type.ERT) {
            if ("5".equals(amountExact)) return 40.0f;
            if ("10".equals(amountExact)) return 120.0f;
            if ("20".equals(amountExact)) return 200.0f;
            if ("50".equals(amountExact)) return 280.0f;
        } else if (type == RaffleV2Reward.Type.ERU) {
            if ("1".equals(amountExact)) return 0.0f;
            if ("5".equals(amountExact)) return 80.0f;
            if ("10".equals(amountExact)) return 160.0f;
            if ("30".equals(amountExact)) return 240.0f;
        } else if (type == RaffleV2Reward.Type.COPPER_RING && amountExact == null) {
            return 320.0f;
        }
        throw new IllegalArgumentException("reward is not present on the approved wheel artwork");
    }

    static float normalizedDegrees(float rotation) {
        float normalized = rotation % 360.0f;
        return normalized < 0.0f ? normalized + 360.0f : normalized;
    }
}
