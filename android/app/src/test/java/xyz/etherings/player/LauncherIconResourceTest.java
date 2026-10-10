package xyz.etherings.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.Drawable;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, qualifiers = "mdpi")
public final class LauncherIconResourceTest {
    private final Context context = ApplicationProvider.getApplicationContext();

    @Test
    public void manifestUsesApprovedLauncherResources() {
        assertEquals(R.mipmap.ic_launcher, context.getApplicationInfo().icon);
        assertNotNull(context.getDrawable(R.mipmap.ic_launcher_round));
    }

    @Test
    public void api28UsesAdaptiveIconWithBrandBackgroundAndForeground() {
        Drawable launcher = context.getDrawable(R.mipmap.ic_launcher);
        Drawable roundLauncher = context.getDrawable(R.mipmap.ic_launcher_round);
        assertTrue(launcher instanceof AdaptiveIconDrawable);
        assertTrue(roundLauncher instanceof AdaptiveIconDrawable);
        AdaptiveIconDrawable adaptive = (AdaptiveIconDrawable) launcher;
        assertNotNull(adaptive.getBackground());
        assertNotNull(adaptive.getForeground());
    }

    @Test
    public void adaptiveForegroundKeepsTransparentCanvasAndSafeCenteredMark() {
        Bitmap bitmap = BitmapFactory.decodeResource(
                context.getResources(), R.mipmap.ic_launcher_foreground);
        assertNotNull(bitmap);
        assertEquals(108, bitmap.getWidth());
        assertEquals(108, bitmap.getHeight());
        assertEquals(0, Color.alpha(bitmap.getPixel(0, 0)));
        assertEquals(0, Color.alpha(bitmap.getPixel(107, 107)));
        assertTrue(Color.alpha(bitmap.getPixel(54, 54)) > 0);
        bitmap.recycle();
    }

}
