package xyz.etherings.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
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

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class HeaderTokenArtworkTest {
    private final Context context = ApplicationProvider.getApplicationContext();

    @Test
    public void approvedTokenArtworkHasTransparentBackgroundAndStableDimensions() {
        int[] resources = {
                R.drawable.header_token_ert,
                R.drawable.header_token_eru
        };

        for (int resource : resources) {
            Bitmap bitmap = BitmapFactory.decodeResource(context.getResources(), resource);
            assertNotNull(bitmap);
            assertEquals(1254, bitmap.getWidth());
            assertEquals(1254, bitmap.getHeight());
            assertTransparent(bitmap, 0, 0);
            assertTransparent(bitmap, bitmap.getWidth() - 1, 0);
            assertTransparent(bitmap, 0, bitmap.getHeight() - 1);
            assertTransparent(bitmap, bitmap.getWidth() - 1, bitmap.getHeight() - 1);
            assertTrue(Color.alpha(bitmap.getPixel(bitmap.getWidth() / 2,
                    bitmap.getHeight() / 2)) >= 252);
            bitmap.recycle();
        }
    }

    @Test
    public void approvedTokenArtworkRemainsVisibleOnBrandBackground() {
        int background = context.getColor(R.color.brand_background);
        int[] resources = {
                R.drawable.header_token_ert,
                R.drawable.header_token_eru
        };

        for (int resource : resources) {
            Bitmap bitmap = BitmapFactory.decodeResource(context.getResources(), resource);
            assertNotNull(bitmap);
            int[] samples = {
                    bitmap.getPixel(bitmap.getWidth() / 2, bitmap.getHeight() / 10),
                    bitmap.getPixel(bitmap.getWidth() / 10, bitmap.getHeight() / 2),
                    bitmap.getPixel(bitmap.getWidth() * 9 / 10, bitmap.getHeight() / 2),
                    bitmap.getPixel(bitmap.getWidth() / 2, bitmap.getHeight() * 9 / 10)
            };
            int strongestDistance = 0;
            for (int sample : samples) {
                assertTrue(Color.alpha(sample) >= 252);
                strongestDistance = Math.max(strongestDistance,
                        colorDistance(sample, background));
            }
            assertTrue(strongestDistance >= 96);
            bitmap.recycle();
        }
    }

    private void assertTransparent(Bitmap bitmap, int x, int y) {
        assertTrue(Color.alpha(bitmap.getPixel(x, y)) <= 1);
    }

    private int colorDistance(int first, int second) {
        return Math.abs(Color.red(first) - Color.red(second))
                + Math.abs(Color.green(first) - Color.green(second))
                + Math.abs(Color.blue(first) - Color.blue(second));
    }
}
