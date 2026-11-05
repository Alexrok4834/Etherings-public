package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AlphaRegistrationConfirmationTest {
    @Test public void mismatchedConfirmationStopsRegistrationBeforeNetworkRequest() {
        AlphaAuthActivity activity = Robolectric.buildActivity(AlphaAuthActivity.class)
                .setup().get();
        EditText email = field(activity.getWindow().getDecorView(), "Email");
        EditText password = field(activity.getWindow().getDecorView(), "Password (8+ characters)");
        EditText confirmation = field(activity.getWindow().getDecorView(), "Confirm password");
        Button create = button(activity.getWindow().getDecorView(), "Create account");
        assertNotNull(email);
        assertNotNull(password);
        assertNotNull(confirmation);
        assertNotNull(create);
        email.setText("player@example.com");
        password.setText("correct-password");
        confirmation.setText("different-password");

        create.performClick();

        assertEquals("Create account", create.getText().toString());
        assertNotNull(text(activity.getWindow().getDecorView(), "Passwords do not match."));
    }

    private static EditText field(View view, String hint) {
        if (view instanceof EditText && hint.contentEquals(((EditText) view).getHint()))
            return (EditText) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            EditText found = field(((ViewGroup) view).getChildAt(i), hint);
            if (found != null) return found;
        }
        return null;
    }

    private static Button button(View view, String label) {
        if (view instanceof Button && label.contentEquals(((Button) view).getText()))
            return (Button) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            Button found = button(((ViewGroup) view).getChildAt(i), label);
            if (found != null) return found;
        }
        return null;
    }

    private static TextView text(View view, String value) {
        if (view instanceof TextView && value.contentEquals(((TextView) view).getText()))
            return (TextView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            TextView found = text(((ViewGroup) view).getChildAt(i), value);
            if (found != null) return found;
        }
        return null;
    }
}
