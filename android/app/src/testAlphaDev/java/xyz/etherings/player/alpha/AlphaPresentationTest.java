package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AlphaPresentationTest {
    @Test public void walletAddressIsShortenedWithoutChangingFullCopySource() {
        String address = "3UUrandd3bZ9EHm6pKDY4qabDGcocBF2NEXYLFND97yr";
        assertEquals("3UUran...ND97yr", AlphaUi.shortAddress(address));
        assertEquals("short", AlphaUi.shortAddress("short"));
    }

    @Test public void primaryAndSecondaryActionsUseDistinctProductSurfaces() {
        Context context = RuntimeEnvironment.getApplication();
        Button primary = AlphaUi.button(context, "Continue", true);
        Button secondary = AlphaUi.button(context, "Cancel", false);
        assertNotEquals(primary.getCurrentTextColor(), secondary.getCurrentTextColor());
        assertEquals("Continue", primary.getText().toString());
        assertTrue(primary.getMinHeight() >= AlphaUi.dp(context, 48));
    }

    private static EditText findCode(ViewGroup group) {
        for (int index = 0; index < group.getChildCount(); index++) {
            android.view.View child = group.getChildAt(index);
            if (child instanceof EditText && "4-digit code".contentEquals(((EditText) child).getHint()))
                return (EditText) child;
            if (child instanceof ViewGroup) {
                EditText found = findCode((ViewGroup) child);
                if (found != null) return found;
            }
        }
        return null;
    }

    @Test public void emailFieldAndFourDigitEntryKeepExpectedInputConstraints() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        EditText email = AlphaUi.field(context, "Email",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        assertEquals(android.view.View.AUTOFILL_HINT_EMAIL_ADDRESS, email.getAutofillHints()[0]);

        AlphaAuthActivity activity = Robolectric.buildActivity(AlphaAuthActivity.class).create().get();
        java.lang.reflect.Method verify = AlphaAuthActivity.class.getDeclaredMethod("verify");
        verify.setAccessible(true);
        verify.invoke(activity);
        EditText code = findCode((ViewGroup) activity.findViewById(android.R.id.content));
        assertTrue(code != null);
        code.setText("12345");
        assertEquals("1234", code.getText().toString());
        activity.finish();
    }

    @Test public void walletSelectedForOneAccountCannotBeOfferedForAnother() {
        AlphaWalletSelectionStore selection = new AlphaWalletSelectionStore(
                RuntimeEnvironment.getApplication());
        selection.clear();
        selection.save("account-a", "wallet-a");
        assertTrue(selection.matches("account-a", "wallet-a"));
        assertTrue(!selection.matches("account-b", "wallet-a"));
        assertTrue(!selection.matches("account-a", "wallet-b"));
        assertTrue(AlphaWalletActivity.mayShowLocalWallet("account-a", "wallet-a", "", selection));
        assertTrue(!AlphaWalletActivity.mayShowLocalWallet("account-b", "wallet-a", "", selection));
        assertTrue(!AlphaWalletActivity.mayShowLocalWallet("account-b", "wallet-a", "wallet-b", selection));
        assertTrue(AlphaWalletActivity.mayShowLocalWallet("account-b", "wallet-a", "wallet-a", selection));
        selection.clear();
        assertTrue(!selection.matches("account-a", "wallet-a"));
    }

    @Test public void normalStarterClaimIsAnAllowedAuthenticatedRoute() {
        assertTrue(AlphaAuthApi.isWalletPost("/starter/claim"));
        assertTrue(!AlphaAuthApi.isWalletPost("/starter/claim/other"));
    }
}
