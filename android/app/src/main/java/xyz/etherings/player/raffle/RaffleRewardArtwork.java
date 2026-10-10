package xyz.etherings.player.raffle;

import androidx.annotation.DrawableRes;

import xyz.etherings.player.R;

public final class RaffleRewardArtwork {
    private RaffleRewardArtwork() {}

    @DrawableRes
    public static int drawableFor(RaffleV2Reward reward) {
        if (reward == null) throw new IllegalArgumentException("validated reward is required");
        return drawableFor(reward.type(), reward.amountExact());
    }

    @DrawableRes
    static int drawableFor(RaffleV2Reward.Type type, String amountExact) {
        if (type == RaffleV2Reward.Type.ERT) {
            if ("5".equals(amountExact)) return R.drawable.raffle_reward_ert_5;
            if ("10".equals(amountExact)) return R.drawable.raffle_reward_ert_10;
            if ("20".equals(amountExact)) return R.drawable.raffle_reward_ert_20;
            if ("50".equals(amountExact)) return R.drawable.raffle_reward_ert_50;
        } else if (type == RaffleV2Reward.Type.ERU) {
            if ("1".equals(amountExact)) return R.drawable.raffle_reward_eru_1;
            if ("5".equals(amountExact)) return R.drawable.raffle_reward_eru_5;
            if ("10".equals(amountExact)) return R.drawable.raffle_reward_eru_10;
            if ("30".equals(amountExact)) return R.drawable.raffle_reward_eru_30;
        } else if (type == RaffleV2Reward.Type.COPPER_RING && amountExact == null) {
            return R.drawable.raffle_reward_cooper_ring;
        }
        throw new IllegalArgumentException("No approved artwork for validated reward");
    }
}
