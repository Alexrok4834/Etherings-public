package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import xyz.etherings.player.R;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RaffleRewardArtworkTest {
    private final Context context = ApplicationProvider.getApplicationContext();

    @Test
    public void currencyRewardArtworkHasTransparentBackgroundAndStableDimensions() {
        int[] resources = {
                R.drawable.raffle_reward_ert_5,
                R.drawable.raffle_reward_ert_10,
                R.drawable.raffle_reward_ert_20,
                R.drawable.raffle_reward_ert_50,
                R.drawable.raffle_reward_eru_1,
                R.drawable.raffle_reward_eru_5,
                R.drawable.raffle_reward_eru_10,
                R.drawable.raffle_reward_eru_30
        };

        for (int resource : resources) {
            Bitmap bitmap = BitmapFactory.decodeResource(context.getResources(), resource);
            assertNotNull(bitmap);
            assertEquals(1254, bitmap.getWidth());
            assertEquals(1254, bitmap.getHeight());
            assertTransparentCorner(bitmap, 0, 0);
            assertTransparentCorner(bitmap, bitmap.getWidth() - 1, 0);
            assertTransparentCorner(bitmap, 0, bitmap.getHeight() - 1);
            assertTransparentCorner(bitmap, bitmap.getWidth() - 1, bitmap.getHeight() - 1);
            assertTrue(Color.alpha(bitmap.getPixel(bitmap.getWidth() / 2,
                    bitmap.getHeight() / 2)) >= 252);
            bitmap.recycle();
        }
    }

    @Test
    public void cooperRingArtworkHasTransparentBackgroundAndOpening() {
        Bitmap bitmap = BitmapFactory.decodeResource(context.getResources(),
                R.drawable.raffle_reward_cooper_ring);
        assertNotNull(bitmap);
        assertEquals(1254, bitmap.getWidth());
        assertEquals(1254, bitmap.getHeight());
        assertTransparentCorner(bitmap, 0, 0);
        assertTransparentCorner(bitmap, bitmap.getWidth() - 1, 0);
        assertTransparentCorner(bitmap, 0, bitmap.getHeight() - 1);
        assertTransparentCorner(bitmap, bitmap.getWidth() - 1, bitmap.getHeight() - 1);
        assertTransparentCorner(bitmap, bitmap.getWidth() / 2, 500);
        assertTransparentCorner(bitmap, 350, 600);
        assertTrue(Color.alpha(bitmap.getPixel(bitmap.getWidth() / 2, 350)) >= 252);
        assertTrue(Color.alpha(bitmap.getPixel(bitmap.getWidth() / 2, 800)) >= 252);
        bitmap.recycle();
    }

    @Test
    public void validatedTypeAndExactAmountSelectEveryApprovedArtwork() {
        assertEquals(R.drawable.raffle_reward_ert_5,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERT, "5"));
        assertEquals(R.drawable.raffle_reward_ert_10,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERT, "10"));
        assertEquals(R.drawable.raffle_reward_ert_20,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERT, "20"));
        assertEquals(R.drawable.raffle_reward_ert_50,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERT, "50"));
        assertEquals(R.drawable.raffle_reward_eru_1,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERU, "1"));
        assertEquals(R.drawable.raffle_reward_eru_5,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERU, "5"));
        assertEquals(R.drawable.raffle_reward_eru_10,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERU, "10"));
        assertEquals(R.drawable.raffle_reward_eru_30,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERU, "30"));
        assertEquals(R.drawable.raffle_reward_cooper_ring,
                RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.COPPER_RING, null));
    }

    @Test
    public void unsupportedValidatedRewardFailsClosed() {
        assertThrows(IllegalArgumentException.class,
                () -> RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERT, "1"));
        assertThrows(IllegalArgumentException.class,
                () -> RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.ERU, "2"));
        assertThrows(IllegalArgumentException.class,
                () -> RaffleRewardArtwork.drawableFor(RaffleV2Reward.Type.COPPER_RING, "1"));
    }

    private void assertTransparentCorner(Bitmap bitmap, int x, int y) {
        assertTrue(Color.alpha(bitmap.getPixel(x, y)) <= 1);
    }
}
