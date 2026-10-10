package xyz.etherings.player;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;

public class BorderDrawable extends Drawable {
    private final float borderWidth;
    private final float cornerRadius;
    private final Paint fillPaint;
    private final Paint borderPaint;

    public BorderDrawable(int borderColor, float borderWidth, float cornerRadius) {
        this(borderColor, borderWidth, cornerRadius, Color.TRANSPARENT);
    }

    public BorderDrawable(int borderColor, float borderWidth, float cornerRadius, int fillColor) {
        this.borderWidth = borderWidth;
        this.cornerRadius = cornerRadius;
        this.fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        this.fillPaint.setStyle(Paint.Style.FILL);
        this.fillPaint.setColor(fillColor);
        this.borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        this.borderPaint.setStyle(Paint.Style.STROKE);
        this.borderPaint.setStrokeWidth(borderWidth);
        this.borderPaint.setColor(borderColor);
    }

    @Override
    public void draw(Canvas canvas) {
        float half = borderWidth / 2f;
        RectF rect = new RectF(getBounds());
        rect.inset(half, half);
        canvas.drawRoundRect(rect, cornerRadius, cornerRadius, fillPaint);
        canvas.drawRoundRect(rect, cornerRadius, cornerRadius, borderPaint);
    }

    @Override
    public void setAlpha(int alpha) {
        fillPaint.setAlpha(alpha);
        borderPaint.setAlpha(alpha);
    }

    @Override
    public void setColorFilter(ColorFilter colorFilter) {
        fillPaint.setColorFilter(colorFilter);
        borderPaint.setColorFilter(colorFilter);
    }

    @Override
    public int getOpacity() {
        return PixelFormat.TRANSLUCENT;
    }
}