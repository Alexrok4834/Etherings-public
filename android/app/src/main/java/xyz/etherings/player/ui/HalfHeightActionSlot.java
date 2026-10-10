package xyz.etherings.player.ui;

import android.content.Context;
import android.view.View;
import android.widget.FrameLayout;

public final class HalfHeightActionSlot extends FrameLayout {
    public HalfHeightActionSlot(Context context) {
        super(context);
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
        if (getChildCount() == 0) return;
        getChildAt(0).measure(
                View.MeasureSpec.makeMeasureSpec(getMeasuredWidth(), View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(
                        Math.max(1, getMeasuredHeight() / 2),
                        View.MeasureSpec.EXACTLY
                )
        );
    }

    @Override
    protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        if (getChildCount() == 0) return;
        View child = getChildAt(0);
        int childTop = (getMeasuredHeight() - child.getMeasuredHeight()) / 2;
        child.layout(0, childTop, child.getMeasuredWidth(), childTop + child.getMeasuredHeight());
    }
}
