package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;

import android.graphics.Bitmap;
import android.graphics.Color;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class AlphaCooperArtworkLayoutTest {
    @Test public void trimsOnlyTransparentPresentationMargins() {
        Bitmap bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.TRANSPARENT);
        for (int y = 40; y < 60; y++) for (int x = 40; x < 60; x++)
            bitmap.setPixel(x, y, Color.YELLOW);
        Bitmap cropped = AlphaCooperArtwork.trimTransparentMargins(bitmap);
        assertEquals(28, cropped.getWidth());
        assertEquals(28, cropped.getHeight());
        assertEquals(Color.YELLOW, cropped.getPixel(4, 4));
        Bitmap opaque = Bitmap.createBitmap(100, 100, Bitmap.Config.RGB_565);
        assertSame(opaque, AlphaCooperArtwork.trimTransparentMargins(opaque));
    }
}
