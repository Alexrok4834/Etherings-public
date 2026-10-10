package xyz.etherings.player.ui;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.view.View;
import android.widget.TextView;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class HalfHeightActionSlotTest {
    @Test
    public void measuresFullWidthFrameAtHalfHeightAndCentersItVertically() {
        Context context = ApplicationProvider.getApplicationContext();
        HalfHeightActionSlot slot = new HalfHeightActionSlot(context);
        TextView frame = new TextView(context);
        slot.addView(frame);

        slot.measure(
                View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(48, View.MeasureSpec.EXACTLY)
        );
        slot.layout(0, 0, 200, 48);

        assertEquals(200, frame.getMeasuredWidth());
        assertEquals(24, frame.getMeasuredHeight());
        assertEquals(0, frame.getLeft());
        assertEquals(12, frame.getTop());
        assertEquals(36, frame.getBottom());
    }
}
