package xyz.etherings.player.alpha;

import android.app.Activity;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import xyz.etherings.player.R;

final class AlphaUi {
    private AlphaUi() { }

    static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    static void window(Activity activity) {
        activity.getWindow().setStatusBarColor(activity.getColor(R.color.brand_background));
        activity.getWindow().setNavigationBarColor(activity.getColor(R.color.brand_background));
        activity.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }

    static GradientDrawable shape(Context context, int fill, boolean outline) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(context.getColor(fill));
        drawable.setCornerRadius(dp(context, 6));
        if (outline) drawable.setStroke(dp(context, 1), context.getColor(R.color.brand_outline));
        return drawable;
    }

    static ScrollView scroll(Activity activity, LinearLayout root) {
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setBackgroundColor(activity.getColor(R.color.brand_background));
        scroll.addView(root);
        return scroll;
    }

    static LinearLayout column(Context context) {
        LinearLayout layout = new LinearLayout(context);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    static ImageView logo(Context context, int height) {
        ImageView logo = new ImageView(context);
        logo.setImageResource(R.drawable.etherings_logo_gold);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setContentDescription("EtheRings");
        logo.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(context, height)));
        return logo;
    }

    static TextView text(Context context, String value, int size, int color) {
        TextView text = new TextView(context);
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(context.getColor(color));
        text.setIncludeFontPadding(true);
        return text;
    }

    static Button button(Context context, String title, boolean primary) {
        Button button = new Button(context);
        button.setText(title);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(dp(context, 48));
        button.setElevation(0);
        button.setTextColor(context.getColor(primary ? R.color.brand_on_accent :
                R.color.brand_text_primary));
        GradientDrawable background = shape(context,
                primary ? R.color.brand_accent : R.color.brand_surface_elevated, !primary);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(context.getColor(
                primary ? R.color.brand_text_secondary : R.color.brand_outline)),
                background, null));
        return button;
    }

    static TextView link(Context context, String title) {
        TextView link = text(context, title, 14, R.color.brand_accent);
        link.setGravity(Gravity.CENTER);
        link.setMinHeight(dp(context, 44));
        link.setClickable(true);
        link.setFocusable(true);
        return link;
    }

    static EditText field(Context context, String hint, int inputType) {
        EditText edit = new EditText(context);
        edit.setSingleLine(true);
        edit.setHint(hint);
        edit.setInputType(inputType);
        edit.setImeOptions(EditorInfo.IME_ACTION_NEXT);
        edit.setTextSize(16);
        edit.setTextColor(context.getColor(R.color.brand_text_primary));
        edit.setHintTextColor(context.getColor(R.color.brand_text_subtle));
        edit.setPadding(dp(context, 14), 0, dp(context, 14), 0);
        edit.setBackground(shape(context, R.color.brand_surface_elevated, true));
        if ((inputType & InputType.TYPE_MASK_VARIATION) ==
                InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
            edit.setAutofillHints(View.AUTOFILL_HINT_EMAIL_ADDRESS);
        return edit;
    }

    static String shortAddress(String address) {
        if (address == null || address.length() < 14) return address;
        return address.substring(0, 6) + "..." + address.substring(address.length() - 6);
    }
}
