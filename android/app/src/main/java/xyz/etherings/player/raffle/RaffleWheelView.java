package xyz.etherings.player.raffle;

import android.animation.ValueAnimator;
import android.animation.Animator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.provider.Settings;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.DecelerateInterpolator;

import androidx.annotation.Nullable;

import xyz.etherings.player.R;

public final class RaffleWheelView extends View {
    public interface OnLandingListener { void onLanding(); }
    private enum State { EMPTY, READY, WAITING, RESULT }

    private static final long LANDING_DURATION_MS = 4200L;
    private static final long WAITING_TURN_MS = 1200L;
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint bitmapPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG
            | Paint.DITHER_FLAG);
    private final RectF wheelBounds = new RectF();
    private final Rect bitmapBounds = new Rect();
    private final Path pointer = new Path();
    private final Bitmap wheelBitmap;

    private State state = State.EMPTY;
    private RaffleWheelModel model;
    private float rotationDegrees;
    private ValueAnimator animator;
    private OnLandingListener landingListener;

    public RaffleWheelView(Context context) { this(context, null); }

    public RaffleWheelView(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(dp(2));
        wheelBitmap = BitmapFactory.decodeResource(getResources(), R.drawable.raffle_wheel);
        if (wheelBitmap == null) throw new IllegalStateException("raffle wheel artwork is missing");
        bitmapBounds.set(0, 0, wheelBitmap.getWidth(), wheelBitmap.getHeight());
        setContentDescription(getContext().getString(R.string.raffle_wheel_content_description));
    }

    public void showWaiting(boolean reducedMotion) {
        cancelAnimator();
        model = null;
        state = State.WAITING;
        rotationDegrees = 0.0f;
        setContentDescription(getContext().getString(R.string.raffle_wheel_waiting_content_description));
        if (!reducedMotion && areSystemAnimatorsEnabled()) {
            animator = ValueAnimator.ofFloat(0.0f, 360.0f);
            animator.setDuration(WAITING_TURN_MS);
            animator.setRepeatCount(ValueAnimator.INFINITE);
            animator.addUpdateListener(value -> {
                rotationDegrees = (Float) value.getAnimatedValue();
                postInvalidateOnAnimation();
            });
            animator.start();
        }
        invalidate();
    }

    public void showReady(RaffleWheelModel readyModel) {
        if (readyModel == null || readyModel.segments().isEmpty()
                || readyModel.selectedSegmentIndex() >= 0) {
            throw new IllegalArgumentException("unselected current Draw model is required");
        }
        cancelAnimator();
        model = readyModel;
        state = State.READY;
        rotationDegrees = 0.0f;
        setContentDescription(getContext().getString(R.string.raffle_wheel_ready_content_description));
        invalidate();
    }

    public void showResult(RaffleWheelModel nextModel, boolean reducedMotion) {
        if (nextModel == null || nextModel.segments().isEmpty()) {
            throw new IllegalArgumentException("validated wheel model is required");
        }
        cancelAnimator();
        model = nextModel;
        state = State.RESULT;
        float landing = RaffleWheelMotion.landingRotationDegrees(nextModel);
        setContentDescription(getContext().getString(R.string.raffle_wheel_result_content_description,
                displayTitle(nextModel.selectedSegment())));
        if (reducedMotion || !areSystemAnimatorsEnabled()) {
            rotationDegrees = RaffleWheelMotion.normalizedDegrees(landing);
            invalidate();
            notifyLanding();
            return;
        }
        rotationDegrees = 0.0f;
        animator = ValueAnimator.ofFloat(0.0f, landing);
        animator.setDuration(LANDING_DURATION_MS);
        animator.setInterpolator(new DecelerateInterpolator());
        animator.addUpdateListener(value -> {
            rotationDegrees = (Float) value.getAnimatedValue();
            postInvalidateOnAnimation();
        });
        animator.addListener(new Animator.AnimatorListener() {
            private boolean cancelled;

            @Override public void onAnimationStart(Animator animation) { cancelled = false; }
            @Override public void onAnimationCancel(Animator animation) { cancelled = true; }
            @Override public void onAnimationRepeat(Animator animation) {}
            @Override public void onAnimationEnd(Animator animation) {
                if (!cancelled) notifyLanding();
            }
        });
        animator.start();
    }

    public void setOnLandingListener(OnLandingListener listener) {
        landingListener = listener;
    }

    public void clear() {
        cancelAnimator();
        state = State.EMPTY;
        model = null;
        rotationDegrees = 0.0f;
        setContentDescription(getContext().getString(R.string.raffle_wheel_content_description));
        invalidate();
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int desired = dp(320);
        int width = resolveSize(desired, widthMeasureSpec);
        int height = resolveSize(desired, heightMeasureSpec);
        int size = Math.min(width, height);
        setMeasuredDimension(size, size);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float size = Math.min(getWidth(), getHeight());
        float padding = dp(12);
        float diameter = Math.max(0.0f, size - padding * 2.0f - dp(10));
        float left = (getWidth() - diameter) / 2.0f;
        float top = padding + dp(9);
        wheelBounds.set(left, top, left + diameter, top + diameter);

        if (state == State.WAITING) drawWaiting(canvas);
        else if ((state == State.READY || state == State.RESULT) && model != null) drawResult(canvas);
        else drawEmpty(canvas);
        drawPointer(canvas);
    }

    private void drawEmpty(Canvas canvas) {
        fill.setStyle(Paint.Style.FILL);
        fill.setColor(getContext().getColor(R.color.brand_surface_elevated));
        canvas.drawOval(wheelBounds, fill);
        stroke.setColor(getContext().getColor(R.color.brand_outline));
        canvas.drawOval(wheelBounds, stroke);
    }

    private void drawWaiting(Canvas canvas) {
        drawWheelBitmap(canvas);
    }

    private void drawResult(Canvas canvas) {
        drawWheelBitmap(canvas);
    }

    private void drawWheelBitmap(Canvas canvas) {
        canvas.save();
        canvas.rotate(rotationDegrees, wheelBounds.centerX(), wheelBounds.centerY());
        canvas.drawBitmap(wheelBitmap, bitmapBounds, wheelBounds, bitmapPaint);
        canvas.restore();
    }

    private void drawPointer(Canvas canvas) {
        float cx = wheelBounds.centerX();
        float top = wheelBounds.top - dp(5);
        pointer.reset();
        pointer.moveTo(cx, top + dp(18));
        pointer.lineTo(cx - dp(10), top);
        pointer.lineTo(cx + dp(10), top);
        pointer.close();
        fill.setColor(getContext().getColor(R.color.brand_accent));
        canvas.drawPath(pointer, fill);
        stroke.setColor(getContext().getColor(R.color.brand_background));
        stroke.setStrokeWidth(dp(1));
        canvas.drawPath(pointer, stroke);
    }

    private String displayTitle(RaffleWheelModel.Segment segment) {
        return segment.title() == null
                ? getContext().getString(R.string.raffle_reward_fallback, segment.segmentIndex() + 1)
                : segment.title();
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void cancelAnimator() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
    }

    private void notifyLanding() {
        OnLandingListener listener = landingListener;
        if (listener != null) listener.onLanding();
    }

    private boolean areSystemAnimatorsEnabled() {
        float durationScale = Settings.Global.getFloat(getContext().getContentResolver(),
                Settings.Global.ANIMATOR_DURATION_SCALE, 1.0f);
        return durationScale > 0.0f && ValueAnimator.areAnimatorsEnabled();
    }

    @Override
    protected void onDetachedFromWindow() {
        cancelAnimator();
        super.onDetachedFromWindow();
    }

    float rotationDegreesForTest() { return rotationDegrees; }
    boolean hasRunningAnimatorForTest() { return animator != null && animator.isRunning(); }
}
