package xyz.etherings.player.alpha;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.Log;
import android.content.res.ColorStateList;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;
import org.json.JSONArray;

import com.google.zxing.common.BitMatrix;

import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.MainActivity;
import xyz.etherings.player.R;
import xyz.etherings.player.step.StepForegroundService;
import xyz.etherings.player.alpha.wallet.AlphaWallet;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;
import xyz.etherings.player.alpha.wallet.EruSendAmount;
import xyz.etherings.player.alpha.wallet.GatewayMessagePolicy;
import xyz.etherings.player.alpha.wallet.WalletAssetSnapshot;
import xyz.etherings.player.alpha.wallet.WalletOperation;
import xyz.etherings.player.alpha.wallet.WalletQr;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

public final class AlphaWalletActivity extends Activity {
    static final String CANONICAL_ERU_MINT = CooperEruPolicy.MINT;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private AlphaAuthApi api;
    private AlphaSessionStore sessions;
    private AlphaWalletSelectionStore selection;
    private AlphaWallet wallet;
    private AlphaEruSubmissionStore submissions;
    private final Handler refreshHandler = new Handler(Looper.getMainLooper());
    private AlphaWallet.Creation pendingCreation;
    private LinearLayout content;
    private TextView feedback;
    private String accountId;
    private String accountEmail;
    private String localAddress;
    private String boundAddress;
    private String availableEru;
    private volatile int generation;
    private boolean firstResume = true;
    private boolean signingOut;
    private TextView revealedPhraseView;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        sessions = new AlphaSessionStore(this);
        selection = new AlphaWalletSelectionStore(this);
        wallet = new AlphaWallet(this);
        submissions = new AlphaEruSubmissionStore(this);
        try { api = new AlphaAuthApi(this, BuildConfig.ALPHA_DEV_API_BASE_URL); }
        catch (IllegalArgumentException ignored) { page("Wallet unavailable"); return; }
        if (getIntent().getBooleanExtra(MainActivity.ALPHA_LOGOUT, false))
            confirmSignOut();
        else if (getIntent().getBooleanExtra(MainActivity.ALPHA_REVEAL_PHRASE, false))
            revealPhraseForm();
        else if (getIntent().getBooleanExtra(MainActivity.ALPHA_CHANGE_PASSWORD, false))
            changePasswordForm();
        else refresh();
    }

    @Override protected void onResume() {
        super.onResume();
        if (firstResume) firstResume = false;
        else if (getIntent().getBooleanExtra(MainActivity.ALPHA_REVEAL_PHRASE, false))
            revealPhraseForm();
        else if (getIntent().getBooleanExtra(MainActivity.ALPHA_LOGOUT, false) ||
                getIntent().getBooleanExtra(MainActivity.ALPHA_CHANGE_PASSWORD, false)) return;
        else {
            discardCreation();
            refresh();
        }
    }

    @Override protected void onDestroy() {
        discardCreation();
        refreshHandler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        super.onDestroy();
    }

    @Override protected void onPause() {
        if (revealedPhraseView != null) {
            revealedPhraseView.setText("");
            revealedPhraseView = null;
        }
        super.onPause();
    }

    @Override public void onBackPressed() {
        if (signingOut) return;
        if (pendingCreation != null) {
            discardCreation();
            refresh();
        } else super.onBackPressed();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void page(String title) {
        generation++;
        refreshHandler.removeCallbacksAndMessages(null);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        AlphaUi.window(this);
        content = AlphaUi.column(this);
        content.setPadding(dp(20), dp(12), dp(20), dp(24));
        setContentView(AlphaUi.scroll(this, content));
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ImageButton back = new ImageButton(this);
        back.setImageResource(R.drawable.ic_arrow_back);
        back.setBackground(AlphaUi.shape(this, R.color.brand_surface, false));
        back.setContentDescription("Back");
        back.setOnClickListener(view -> finish());
        header.addView(back, new LinearLayout.LayoutParams(dp(44), dp(44)));
        TextView heading = AlphaUi.text(this, title, 20, R.color.brand_text_primary);
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(0, -2, 1f);
        headingParams.leftMargin = dp(12);
        header.addView(heading, headingParams);
        TextView network = AlphaUi.text(this, "DEVNET", 11, R.color.brand_accent);
        network.setPadding(dp(8), dp(5), dp(8), dp(5));
        network.setBackground(AlphaUi.shape(this, R.color.brand_surface_elevated, false));
        header.addView(network);
        LinearLayout.LayoutParams headerParams = new LinearLayout.LayoutParams(-1, dp(52));
        headerParams.bottomMargin = dp(8);
        content.addView(header, headerParams);
        feedback = label("", 14);
        feedback.setTextColor(getColor(R.color.brand_error));
        collapseWhenEmpty(feedback);

    }

    private static void collapseWhenEmpty(TextView text) {
        text.setVisibility(View.GONE);
        text.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable value) {
                text.setVisibility(value.length() == 0 ? View.GONE : View.VISIBLE);
            }
        });
    }

    private TextView label(String value, int size) {
        TextView text = AlphaUi.text(this, value, size, R.color.brand_text_primary);
        text.setPadding(0, dp(7), 0, dp(7));
        content.addView(text);
        return text;
    }

    private Button button(String title) {
        return addButton(title, false);
    }

    private Button primaryButton(String title) {
        return addButton(title, true);
    }

    private Button addButton(String title, boolean primary) {
        Button button = AlphaUi.button(this, title, primary);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(48));
        params.bottomMargin = dp(10);
        content.addView(button, params);
        return button;
    }

    private TextView section(String title) {
        TextView heading = AlphaUi.text(this, title, 17, R.color.brand_text_primary);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(16);
        params.bottomMargin = dp(4);
        content.addView(heading, params);
        return heading;
    }

    private TextView assetRow(String symbol, String subtitle, int icon) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        if (icon != 0) {
            ImageView image = new ImageView(this);
            image.setImageResource(icon);
            image.setScaleType(ImageView.ScaleType.FIT_CENTER);
            row.addView(image, new LinearLayout.LayoutParams(dp(36), dp(36)));
        } else {
            TextView mark = AlphaUi.text(this, symbol, 11,
                    R.color.brand_accent);
            mark.setGravity(Gravity.CENTER);
            mark.setBackground(AlphaUi.shape(this, R.color.brand_surface_elevated, false));
            row.addView(mark, new LinearLayout.LayoutParams(dp(36), dp(36)));
        }
        LinearLayout names = AlphaUi.column(this);
        LinearLayout.LayoutParams namesParams = new LinearLayout.LayoutParams(0, -2, 1f);
        namesParams.leftMargin = dp(12);
        row.addView(names, namesParams);
        names.addView(AlphaUi.text(this, symbol, 16, R.color.brand_text_primary));
        names.addView(AlphaUi.text(this, subtitle, 12, R.color.brand_text_subtle));
        TextView value = AlphaUi.text(this, "...", 16, R.color.brand_text_primary);
        value.setGravity(Gravity.END);
        value.setMaxLines(1);
        row.addView(value, new LinearLayout.LayoutParams(-2, -2));
        content.addView(row, new LinearLayout.LayoutParams(-1, dp(62)));
        View divider = new View(this);
        divider.setBackgroundColor(getColor(R.color.brand_outline));
        content.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
        return value;
    }

    private void authRequired() {
        if (isFinishing() || isDestroyed()) return;
        sessions.clear();
        stopService(StepForegroundService.stopIntent(this));
        startActivity(new Intent(this, AlphaAuthActivity.class));
        finish();
    }

    private EditText passwordField(String hint) {
        EditText field = AlphaUi.field(this, hint,
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        content.addView(field, new LinearLayout.LayoutParams(-1, dp(52)));
        return field;
    }

    private boolean sameVerifiedSession(AlphaSessionStore.VerifiedSession expected) {
        AlphaSessionStore.VerifiedSession current = sessions.verified();
        return current != null && expected != null &&
                expected.ownerId().equals(current.ownerId()) &&
                expected.lineage().equals(current.lineage());
    }

    private void revealPhraseForm() {
        page("View recovery phrase");
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        label("Enter your account password to view the recovery phrase on this device.", 16);
        EditText password = passwordField("Account password");
        Button reveal = primaryButton("Verify and show phrase");
        int request = generation;
        reveal.setOnClickListener(view -> {
            AlphaSessionStore.VerifiedSession session = sessions.verified();
            if (session == null) { authRequired(); return; }
            String entered = password.getText().toString();
            password.setText("");
            if (entered.isEmpty()) { feedback.setText("Enter your password."); return; }
            reveal.setEnabled(false);
            io.execute(() -> {
                char[] phrase = null;
                try {
                    AlphaAuthApi.Result auth = api.post("/auth/reauthenticate",
                            new JSONObject().put("password", entered), session.token());
                    if (auth.status != 204) {
                        int status = auth.status;
                        runOnUiThread(() -> {
                            if (request != generation || !sameVerifiedSession(session)) return;
                            reveal.setEnabled(true);
                            feedback.setText(status == 429 ? "Too many attempts. Try later." :
                                    "Password not accepted. Phrase was not shown.");
                        });
                        return;
                    }
                    AlphaAuthApi.Result binding = api.get("/wallet", session.token());
                    if (binding.status != 200 || !wallet.exists())
                        throw new IllegalStateException("Current wallet unavailable");
                    String local = wallet.address();
                    String bound = binding.body.isNull("walletAddress") ? "" :
                            binding.body.getString("walletAddress");
                    if (!local.equals(bound) && !selection.matches(session.ownerId(), local))
                        throw new IllegalStateException("Current wallet does not belong to account");
                    phrase = wallet.recoveryPhrase();
                    char[] shown = phrase;
                    phrase = null;
                    runOnUiThread(() -> {
                        try {
                            if (request != generation || !sameVerifiedSession(session)) return;
                            page("Recovery phrase");
                            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                            label("Keep this phrase private. Anyone with it controls this wallet.", 16);
                            TextView words = label(new String(shown), 18);
                            revealedPhraseView = words;
                            words.setTextIsSelectable(false);
                            primaryButton("Hide phrase").setOnClickListener(button -> {
                                words.setText("");
                                revealedPhraseView = null;
                                finish();
                            });
                        } finally { Arrays.fill(shown, '\0'); }
                    });
                } catch (Exception ignored) {
                    if (phrase != null) Arrays.fill(phrase, '\0');
                    runOnUiThread(() -> {
                        if (request != generation || !sameVerifiedSession(session)) return;
                        reveal.setEnabled(true);
                        feedback.setText("Phrase could not be shown. Check your account and local wallet.");
                    });
                }
            });
        });
    }

    private void changePasswordForm() {
        page("Change password");
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        label("Use your current account password to set a new password.", 16);
        EditText current = passwordField("Current password");
        EditText next = passwordField("New password (8+ characters)");
        EditText confirmation = passwordField("Confirm new password");
        Button change = primaryButton("Change password");
        int request = generation;
        change.setOnClickListener(view -> {
            AlphaSessionStore.VerifiedSession session = sessions.verified();
            if (session == null) { authRequired(); return; }
            String oldPassword = current.getText().toString();
            String newPassword = next.getText().toString();
            String confirmed = confirmation.getText().toString();
            current.setText("");
            next.setText("");
            confirmation.setText("");
            if (oldPassword.isEmpty() || newPassword.length() < 8 ||
                    !newPassword.equals(confirmed) || newPassword.equals(oldPassword)) {
                feedback.setText("Check the current password and matching new password (8+ characters).");
                return;
            }
            change.setEnabled(false);
            io.execute(() -> {
                try {
                    AlphaAuthApi.Result result = api.post("/auth/change-password",
                            new JSONObject().put("currentPassword", oldPassword)
                                    .put("newPassword", newPassword), session.token());
                    runOnUiThread(() -> {
                        if (request != generation || !sameVerifiedSession(session)) return;
                        change.setEnabled(true);
                        feedback.setText(result.status == 204 ? "Password changed." :
                                result.status == 429 ? "Too many attempts. Try later." :
                                "Password was not changed. Check the current password.");
                    });
                } catch (Exception ignored) {
                    runOnUiThread(() -> {
                        if (request != generation || !sameVerifiedSession(session)) return;
                        change.setEnabled(true);
                        feedback.setText("Password change unavailable. Try again later.");
                    });
                }
            });
        });
    }

    private void confirmSignOut() {
        page("Sign out");
        label("Before signing out, make sure you have saved your recovery phrase. " +
                "This removes all local user data and wallet keys. Even on this same phone, " +
                "the next login will require restoring your wallet from the phrase.", 16);
        label("Unsent steps and local records of unfinished operations will be deleted " +
                "and may never be credited. This loss is your risk. Your server account, " +
                "recorded ERT and on-chain assets are not deleted.", 15);
        CheckBox saved = new CheckBox(this);
        saved.setText("I have saved my recovery phrase and understand the local data loss.");
        content.addView(saved);
        Button confirm = primaryButton("Delete local data and sign out");
        confirm.setEnabled(false);
        saved.setOnCheckedChangeListener((button, checked) -> confirm.setEnabled(checked));
        confirm.setOnClickListener(view -> signOut());
        button("Cancel").setOnClickListener(view -> finish());
    }

    private void signOut() {
        signingOut = true;
        stopService(StepForegroundService.stopIntent(this));
        page("Signing out...");
        label("Clearing this device's local Alpha data and wallet keys.", 16);
        AlphaSessionIdentity identity = sessions.current();
        io.execute(() -> {
            try {
                if (identity != null) {
                    try {
                        if (identity.refreshToken != null)
                            api.post("/auth/refresh-logout", new JSONObject()
                                    .put("refreshToken", identity.refreshToken), null);
                        else api.post("/auth/logout", null, identity.token);
                    }
                    catch (Exception ignored) { /* Local access is already revoked. */ }
                }
                wallet.delete();
                ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
                if (manager == null || !manager.clearApplicationUserData())
                    throw new IllegalStateException("Android local data clear failed");
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    signingOut = false;
                    page("Sign out unavailable");
                    label("Android could not confirm complete local data deletion. " +
                            "The wallet may already be removed, but other local data may remain. " +
                            "Retry the reset; do not assume sign-out completed.", 16);
                    primaryButton("Retry").setOnClickListener(view -> confirmSignOut());
                });
            }
        });
    }

    private void refresh() {
        page("Wallet");
        label("Loading wallet...", 16);
        int request = generation;
        io.execute(() -> {
            try {
                String token = sessions.load();
                if (token == null) { runOnUiThread(this::authRequired); return; }
                AlphaAuthApi.Result me = api.get("/auth/me", token);
                if (me.status == 401) { runOnUiThread(this::authRequired); return; }
                if (me.status != 200) throw new IllegalStateException("Alpha session unavailable");
                AlphaAuthApi.Result binding = api.get("/wallet", token);
                if (binding.status == 401) { runOnUiThread(this::authRequired); return; }
                if (binding.status != 200) throw new IllegalStateException("Binding unavailable");
                String id = me.body.getString("id");
                String email = me.body.getString("email");
                String bound = binding.body.isNull("walletAddress") ? "" : binding.body.getString("walletAddress");
                String local = wallet.exists() ? wallet.address() : null;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation) return;
                    accountId = id;
                    accountEmail = email;
                    boundAddress = bound;
                    localAddress = local;
                    overview();
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation) return;
                    page("Wallet unavailable");
                    label("Alpha account or wallet state could not be verified.", 16);
                    button("Retry").setOnClickListener(view -> refresh());
                });
            }
        });
    }

    private void overview() {
        page("Wallet");
        if (!mayShowLocalWallet(accountId, localAddress, boundAddress, selection)) {
            label(boundAddress.isEmpty() ? "Your keys stay on this device. Back up your recovery phrase privately." :
                    "Restore your wallet on this device to access this account.", 16);
            if (boundAddress.isEmpty())
                primaryButton("Create new wallet").setOnClickListener(view -> {
                    if (localAddress == null) create(); else switchWallet();
                });
            button("Restore wallet").setOnClickListener(view -> {
                if (localAddress == null) restore(); else switchWallet();
            });
            return;
        }
        TextView addressCaption = AlphaUi.text(this, "WALLET ADDRESS", 11, R.color.brand_text_subtle);
        content.addView(addressCaption);
        LinearLayout addressRow = new LinearLayout(this);
        addressRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView address = AlphaUi.text(this, AlphaUi.shortAddress(localAddress), 16,
                R.color.brand_text_primary);
        addressRow.addView(address, new LinearLayout.LayoutParams(0, -2, 1f));
        ImageButton copy = new ImageButton(this);
        copy.setImageResource(R.drawable.ic_copy);
        copy.setBackground(AlphaUi.shape(this, R.color.brand_surface_elevated, false));
        copy.setContentDescription("Copy wallet address");
        copy.setTooltipText("Copy wallet address");
        copy.setOnClickListener(view -> copyAddress());
        addressRow.addView(copy, new LinearLayout.LayoutParams(dp(44), dp(44)));
        content.addView(addressRow, new LinearLayout.LayoutParams(-1, dp(48)));
        if (boundAddress.isEmpty()) {
            label("Connect this wallet to your account to use it here.", 15);
            primaryButton("Connect wallet").setOnClickListener(view -> requestBinding());
            button("Use a different wallet").setOnClickListener(view -> switchWallet());
        } else if (!boundAddress.equals(localAddress)) {
            label("This account uses a different wallet. Restore that wallet to continue.", 16);
            primaryButton("Use a different wallet").setOnClickListener(view -> switchWallet());
        } else {
            section("Assets");
            TextView solValue = assetRow("SOL", "Network fees", 0);
            TextView eruValue = assetRow("ERU", "EtheRings token", R.drawable.header_token_eru);
            TextView silverValue = assetRow("NFT", "Box / Ring", 0);
            LinearLayout actions = new LinearLayout(this);
            LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-1, dp(52));
            actionParams.topMargin = dp(18);
            content.addView(actions, actionParams);
            Button receive = AlphaUi.button(this, "Receive", false);
            receive.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_receive, 0, 0, 0);
            receive.setCompoundDrawablePadding(dp(8));
            receive.setCompoundDrawableTintList(ColorStateList.valueOf(getColor(R.color.brand_accent)));
            receive.setOnClickListener(view -> receive());
            LinearLayout.LayoutParams receiveParams = new LinearLayout.LayoutParams(0, -1, 1f);
            receiveParams.rightMargin = dp(6);
            actions.addView(receive, receiveParams);
            Button send = AlphaUi.button(this, "Send", true);
            send.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_send, 0, 0, 0);
            send.setCompoundDrawablePadding(dp(8));
            send.setCompoundDrawableTintList(ColorStateList.valueOf(getColor(R.color.brand_on_accent)));
            send.setEnabled(false);
            send.setOnClickListener(view -> sendForm());
            LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(0, -1, 1f);
            sendParams.leftMargin = dp(6);
            actions.addView(send, sendParams);
            TextView sendState = label("", 13);
            sendState.setTextColor(getColor(R.color.brand_text_secondary));
            collapseWhenEmpty(sendState);
            section("Recent activity");
            LinearLayout recent = AlphaUi.column(this);
            content.addView(recent, new LinearLayout.LayoutParams(-1, -2));
            TextView all = AlphaUi.link(this, "View all activity");
            all.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            all.setOnClickListener(view -> history());
            content.addView(all);
            loadAssets(solValue, eruValue, silverValue, send, sendState);
            loadRecentActivity(recent);
        }
    }

    static boolean mayShowLocalWallet(String account, String local, String bound,
            AlphaWalletSelectionStore selection) {
        return local != null && (local.equals(bound) || selection.matches(account, local));
    }

    private void copyAddress() {
        if (localAddress == null) return;
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        clipboard.setPrimaryClip(ClipData.newPlainText("Solana address", localAddress));
        feedback.setTextColor(getColor(R.color.brand_success));
        feedback.setText("Address copied");
    }

    private static String optional(JSONObject row, String key) throws Exception {
        return row.isNull(key) ? null : row.getString(key);
    }

    private static WalletOperation historyOperation(JSONObject row) throws Exception {
        return WalletOperation.from(row.getString("id"), optional(row, "nonce"),
                row.getString("type"), row.getString("direction"),
                optional(row, "amount"), optional(row, "fee"),
                optional(row, "counterparty"), row.getString("status"),
                optional(row, "transactionSignature"), row.getString("createdAt"));
    }

    private static String activityText(WalletOperation operation, String status) {
        DateTimeFormatter time = DateTimeFormatter.ofPattern("dd MMM, HH:mm", Locale.getDefault())
                .withZone(ZoneId.systemDefault());
        String title;
        switch (operation.type) {
            case "send": title = operation.direction.equals("in") ? "Received ERU" : "Sent ERU"; break;
            case "cooper_level_up": title = "Cooper Level-Up"; break;
            case "silver_level_up": title = "Silver Level-Up"; break;
            case "breeding": title = "Cooper breeding"; break;
            case "draw_reward": title = "Draw ERU reward"; break;
            default: title = "Historical ERU transfer";
        }
        if (operation.amount != null) title += "  " + operation.amount + " ERU";
        String line = title + "\n" + status.toUpperCase(Locale.ROOT) + "  |  " +
                time.format(operation.createdAt);
        if (operation.fee != null) line += "\nFee  " + operation.fee + " ERU";
        if (operation.counterparty != null) line += "\n" +
                (operation.direction.equals("in") ? "From  " : "To  ") +
                operation.counterparty.substring(0, 8) + "..." +
                operation.counterparty.substring(operation.counterparty.length() - 8);
        if (operation.shortSignature() != null) line += "\nTx " + operation.shortSignature();
        return line;
    }

    private void loadRecentActivity(LinearLayout recent) {
        int request = generation;
        String token = sessions.load();
        String address = localAddress;
        TextView loading = AlphaUi.text(this, "Loading activity...", 14,
                R.color.brand_text_secondary);
        recent.addView(loading);
        io.execute(() -> {
            try {
                AlphaAuthApi.Result result = api.get("/eru/history", token);
                if (result.status != 200 || !"devnet".equals(result.body.getString("cluster")) ||
                        !address.equals(result.body.getString("walletAddress")))
                    throw new IllegalArgumentException("History unavailable");
                JSONArray rows = result.body.getJSONArray("operations");
                if (rows.length() > 20) throw new IllegalArgumentException("History response too large");
                WalletOperation[] operations = new WalletOperation[Math.min(3, rows.length())];
                for (int index = 0; index < operations.length; index++) {
                    JSONObject row = rows.getJSONObject(index);
                    operations[index] = historyOperation(row);
                }
                AlphaEruSubmissionStore.Marker marker = submissions.load(accountId);
                String uncertain = marker != null && marker.matches(accountId, address) ?
                        marker.intentId : null;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation ||
                            !token.equals(sessions.load())) return;
                    recent.removeAllViews();
                    if (operations.length == 0) {
                        recent.addView(AlphaUi.text(this, uncertain == null ?
                                "No recent transfers" : "Transfer status pending. View all activity.", 14,
                                R.color.brand_text_secondary));
                        return;
                    }
                    for (WalletOperation operation : operations) {
                        String status = operation.displayStatus(uncertain);
                        TextView row = AlphaUi.text(this, activityText(operation, status), 14,
                                R.color.brand_text_secondary);
                        row.setPadding(dp(4), dp(10), dp(4), dp(10));
                        recent.addView(row, new LinearLayout.LayoutParams(-1, -2));
                    }
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation) return;
                    loading.setText("Activity unavailable");
                });
            }
        });
    }

    private void sendForm() {
        page("Send ERU");
        label("Wallet ERU total: " + (availableEru == null ? "Unavailable" : availableEru), 15);
        label("Spendable balance is checked during review.", 13);
        label("Recipient", 14);
        EditText recipient = AlphaUi.field(this, "Solana address", InputType.TYPE_CLASS_TEXT);
        content.addView(recipient, new LinearLayout.LayoutParams(-1, dp(52)));
        label("Amount", 14);
        EditText amount = AlphaUi.field(this, "ERU", InputType.TYPE_CLASS_NUMBER |
                InputType.TYPE_NUMBER_FLAG_DECIMAL);
        content.addView(amount, new LinearLayout.LayoutParams(-1, dp(52)));
        primaryButton("Continue").setOnClickListener(view -> {
            try {
                String owner = recipient.getText().toString().trim();
                AssociatedTokenAddress.decode(owner);
                long principal = EruSendAmount.parse(amount.getText().toString().trim());
                if (owner.equals(localAddress))
                    throw new IllegalArgumentException("Choose another recipient address.");
                reviewEru(owner, principal);
            } catch (IllegalArgumentException error) {
                feedback.setText("Enter a valid recipient and ERU amount.");
            }
        });
    }

    private void reviewEru(String recipient, long amount) {
        if (localAddress == null || !localAddress.equals(boundAddress)) return;
        page("Review ERU transfer");
        TextView state = label("Checking transfer...", 16);
        int request = generation;
        String token = sessions.load();
        String account = accountId;
        String address = localAddress;
        io.execute(() -> {
            String stage = "account";
            try {
                requireCurrentAccount(token, account, address, false);
                stage = "assets";
                AlphaEruSubmissionStore.Marker unresolved = submissions.load(account);
                if (unresolved != null && unresolved.matches(account, address))
                    throw new IllegalStateException("Unresolved ERU submission");
                CanonicalEruSendPolicy policy = new CanonicalEruSendPolicy(address, recipient, amount);
                AlphaAuthApi.Result assets = api.get("/wallet/assets", token);
                if (assets.status != 200) throw new IllegalArgumentException("Asset reader unavailable");
                WalletAssetSnapshot.from(assets.body.getString("cluster"),
                        assets.body.getString("walletAddress"), address,
                        assets.body.getString("eruMint"), CANONICAL_ERU_MINT,
                        assets.body.getString("solLamports"), assets.body.getString("eruBaseUnits"));
                if (!WalletAssetSnapshot.covers(assets.body.getString("eruBaseUnits"),
                        Math.addExact(amount, EruSendAmount.fee(amount))))
                    throw new IllegalArgumentException("Insufficient ERU");
                stage = "clock";
                AlphaDevnetClock clock = new AlphaDevnetClock();
                clock.confirmedSlot();
                stage = "intent";
                AlphaAuthApi.Result issued = api.post("/eru/intent", new JSONObject()
                        .put("recipient", recipient).put("amount", EruSendAmount.format(amount)), token);
                if (issued.status != 200 || !"devnet".equals(issued.body.getString("cluster")))
                    throw new IllegalArgumentException("ERU intent unavailable");
                String intentId = issued.body.getString("id");
                if (!intentId.equals(UUID.fromString(intentId).toString()))
                    throw new IllegalArgumentException("Invalid ERU intent ID");
                byte[] message = Base64.getDecoder().decode(issued.body.getString("message"));
                stage = "policy";
                GatewayMessagePolicy.Decoded decoded = policy.validate(message, clock.confirmedSlot());
                clock.requireFreshBlockhash(decoded.blockhash);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation ||
                            !token.equals(sessions.load())) return;
                    confirmEru(policy, decoded, intentId, token, account, address, recipient);
                });
            } catch (Exception error) {
                Log.w("AlphaEruReview", "Review failed at " + stage + " (" +
                        error.getClass().getSimpleName() + ")");
                String reason = "Insufficient ERU".equals(error.getMessage()) ?
                        "Insufficient ERU for amount plus 2% fee." :
                        "Transfer could not be prepared. Nothing was signed.";
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation) return;
                    state.setText(reason);
                    button("Back to Wallet").setOnClickListener(view -> refresh());
                });
            }
        });
    }

    private static String eru(long baseUnits) { return EruSendAmount.format(baseUnits); }

    private void confirmEru(CanonicalEruSendPolicy policy, GatewayMessagePolicy.Decoded decoded,
            String intentId, String token, String account, String address, String recipient) {
        page("Confirm ERU transfer");
        label("Amount  " + eru(decoded.amountBaseUnits) + " ERU", 17);
        label("Platform fee (2%)  " + eru(decoded.feeBaseUnits) + " ERU", 16);
        label("Total debit  " + eru(Math.addExact(decoded.amountBaseUnits,
                decoded.feeBaseUnits)) + " ERU", 18);
        label("Recipient", 14);
        TextView destination = label(recipient, 15);
        destination.setTextIsSelectable(true);
        label("Network  Solana Devnet | fee in SOL", 14);
        Button confirm = primaryButton("Sign and send");
        Button cancel = button("Cancel");
        cancel.setOnClickListener(view -> refresh());
        confirm.setOnClickListener(view -> {
            confirm.setEnabled(false);
            cancel.setEnabled(false);
            int request = generation;
            io.execute(() -> {
                boolean signed = false;
                AlphaAuthApi.Result outcome = null;
                try {
                    if (request != generation || isFinishing() || isDestroyed())
                        throw new IllegalArgumentException("Review dismissed");
                    requireCurrentAccount(token, account, address, false);
                    AlphaDevnetClock clock = new AlphaDevnetClock();
                    long confirmedSlot = clock.confirmedSlot();
                    AlphaAuthApi.Result refreshed = api.post("/eru/intent", new JSONObject()
                            .put("recipient", recipient)
                            .put("amount", EruSendAmount.format(decoded.amountBaseUnits)), token);
                    if (refreshed.status != 200)
                        throw new IllegalArgumentException("Send intent unavailable before signing");
                    GatewayMessagePolicy.Decoded current = policy.requireSameCandidate(
                            refreshed.body, intentId, decoded.message(), confirmedSlot);
                    clock.requireFreshBlockhash(current.blockhash);
                    if (request != generation || isFinishing() || isDestroyed() ||
                            !token.equals(sessions.load()))
                        throw new IllegalArgumentException("Review or session changed");
                    byte[] signature = wallet.signGatewayMessage(current.message(), current.intent(),
                            recipient, confirmedSlot);
                    try {
                        submissions.save(account, address, intentId);
                        signed = true;
                        if (request != generation || isFinishing() || isDestroyed() ||
                                !token.equals(sessions.load()))
                            throw new IllegalArgumentException("Review or session changed");
                        outcome = api.post("/eru/submit", new JSONObject().put("id", intentId)
                                .put("signatureBase64", Base64.getEncoder().encodeToString(signature)), token);
                    } finally { Arrays.fill(signature, (byte) 0); }
                } catch (Exception ignored) { }
                boolean submitted = signed;
                AlphaAuthApi.Result response = outcome;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation ||
                            !token.equals(sessions.load())) return;
                    page(submitted ? "Transfer submitted" : "Transfer not signed");
                    String status = response == null ? "unknown" : response.body.optString("status", "unknown");
                    if ("pending".equals(status)) status = "unknown";
                    if (!submitted) label("Account or network state changed. Review the transfer again.", 16);
                    else label("Status: " + (status.matches("pending|confirmed|failed|unknown") ?
                            status : "unknown") + "\nCheck activity for the final result. Do not send this transfer again.", 16);
                    button("View activity").setOnClickListener(next -> history());
                    button("Back to Wallet").setOnClickListener(next -> refresh());
                });
            });
        });
    }

    private void history() {
        if (localAddress == null || !localAddress.equals(boundAddress)) return;
        page("Recent activity");
        if (submissions.hasHistoricalMarker(accountId))
            label("An earlier ERU transfer record is retained separately. Its status is not included here.", 13);
        TextView loading = label("Loading history...", 15);
        int request = generation;
        String token = sessions.load();
        String expectedAccount = accountId;
        String expectedAddress = localAddress;
        Button refresh = button("Refresh");
        int itemStart = content.getChildCount();
        refresh.setOnClickListener(view -> loadHistory(request, token, expectedAccount,
                expectedAddress, loading, itemStart));
        loadHistory(request, token, expectedAccount, expectedAddress, loading, itemStart);
    }

    private void loadHistory(int request, String token, String account, String address,
            TextView loading, int itemStart) {
        if (request != generation || token == null || !token.equals(sessions.load())) return;
        refreshHandler.removeCallbacksAndMessages(null);
        loading.setText("Checking ERU operations...");
        io.execute(() -> {
            try {
                AlphaAuthApi.Result result = api.get("/eru/history", token);
                if (result.status == 401) {
                    runOnUiThread(() -> {
                        if (!isFinishing() && !isDestroyed() && request == generation &&
                                token.equals(sessions.load())) authRequired();
                    });
                    return;
                }
                if (result.status != 200 || !"devnet".equals(result.body.getString("cluster")) ||
                        !address.equals(result.body.getString("walletAddress"))) {
                    throw new IllegalArgumentException("History identity mismatch");
                }
                JSONArray rows = result.body.getJSONArray("operations");
                if (rows.length() > 20) throw new IllegalArgumentException("History response too large");
                WalletOperation[] operations = new WalletOperation[rows.length()];
                boolean reconciled = false;
                for (int index = 0; index < rows.length(); index++) {
                    JSONObject row = rows.getJSONObject(index);
                    operations[index] = historyOperation(row);
                    if ("send".equals(operations[index].type) &&
                            ("unknown".equals(operations[index].status) ||
                            "pending".equals(operations[index].status))) {
                        try {
                            AlphaAuthApi.Result settled = api.post("/eru/reconcile",
                                    new JSONObject().put("id", operations[index].id), token);
                            if ((settled.status == 200 &&
                                    "confirmed".equals(settled.body.optString("status"))) ||
                                    (settled.status == 409 &&
                                    "failed".equals(settled.body.optString("status"))))
                                reconciled = true;
                        } catch (Exception ignored) { /* Keep UNKNOWN until authoritative read succeeds. */ }
                    }
                }
                if (reconciled) {
                    AlphaAuthApi.Result updated = api.get("/eru/history", token);
                    if (updated.status != 200 || !"devnet".equals(updated.body.getString("cluster")) ||
                            !address.equals(updated.body.getString("walletAddress")))
                        throw new IllegalArgumentException("Reconciled history identity mismatch");
                    JSONArray latest = updated.body.getJSONArray("operations");
                    if (latest.length() > 20) throw new IllegalArgumentException("History response too large");
                    operations = new WalletOperation[latest.length()];
                    for (int index = 0; index < latest.length(); index++) {
                        JSONObject row = latest.getJSONObject(index);
                        operations[index] = historyOperation(row);
                    }
                }
                AlphaEruSubmissionStore.Marker marker = submissions.load(account);
                boolean localUnknown = marker != null && marker.matches(account, address);
                if (localUnknown) {
                    for (WalletOperation operation : operations) {
                        if (operation.id.equals(marker.intentId) &&
                                (operation.status.equals("confirmed") || operation.status.equals("failed"))) {
                            submissions.clearIf(account, address, marker.intentId);
                            localUnknown = false;
                            break;
                        }
                    }
                }
                WalletOperation[] display = operations;
                boolean stillUnknown = localUnknown;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation ||
                            !token.equals(sessions.load())) return;
                    content.removeViews(itemStart, content.getChildCount() - itemStart);
                    loading.setText("ERU transfers | Devnet");
                    if (display.length == 0 && !stillUnknown) label("No transfers yet", 15);
                    boolean markerShown = false;
                    for (WalletOperation operation : display) {
                        String effectiveStatus = operation.displayStatus(
                                stillUnknown ? marker.intentId : null);
                        boolean uncertain = stillUnknown && operation.id.equals(marker.intentId);
                        if (uncertain) markerShown = true;
                        TextView item = label(activityText(operation, effectiveStatus), 15);
                        if (operation.status.equals("confirmed")) item.setTextColor(getColor(R.color.brand_success));
                        if (operation.status.equals("failed")) item.setTextColor(getColor(R.color.brand_error));
                    }
                    if (stillUnknown && !markerShown)
                        label("Transfer status unknown. Do not send again; check back later.", 15);
                    if (stillUnknown || Arrays.stream(display).anyMatch(op ->
                            op.status.equals("pending") || op.status.equals("unknown")))
                        refreshHandler.postDelayed(() -> loadHistory(request, token, account, address,
                                loading, itemStart), 15_000);
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation) return;
                    loading.setText("History unavailable. Settlement state is not confirmed.");
                    refreshHandler.postDelayed(() -> loadHistory(request, token, account, address,
                            loading, itemStart), 15_000);
                });
            }
        });
    }

    private void loadAssets(TextView sol, TextView eru, TextView silver,
            Button send, TextView sendState) {
        int request = generation;
        String token = sessions.load();
        String expectedAddress = localAddress;
        io.execute(() -> {
            try {
                AlphaAuthApi.Result result = api.get("/wallet/assets", token);
                if (result.status != 200) throw new IllegalStateException("Asset reader unavailable");
                JSONObject body = result.body;
                WalletAssetSnapshot snapshot = WalletAssetSnapshot.from(
                        body.getString("cluster"), body.getString("walletAddress"), expectedAddress,
                        body.getString("eruMint"), CANONICAL_ERU_MINT,
                        body.getString("solLamports"), body.getString("eruBaseUnits"));
                AlphaEruSubmissionStore.Marker unresolved = submissions.load(accountId);
                boolean waiting = unresolved != null && unresolved.matches(accountId, expectedAddress);
                boolean canSend = !waiting && WalletAssetSnapshot.covers(
                        body.getString("eruBaseUnits"), 1);
                JSONArray assets = body.getJSONArray("silver");
                for (int index = 0; index < assets.length(); index++) {
                    JSONObject asset = assets.getJSONObject(index);
                    String kind = asset.getString("kind");
                    String mint = asset.getString("mintAddress");
                    if (!(kind.equals("SILVER_BOX") || kind.equals("SILVER_RING")) ||
                            !mint.matches("[1-9A-HJ-NP-Za-km-z]{32,44}")) {
                        throw new IllegalArgumentException("Invalid Silver asset");
                    }
                }
                int boxes = 0;
                int rings = 0;
                for (int index = 0; index < assets.length(); index++) {
                    if ("SILVER_BOX".equals(assets.getJSONObject(index).getString("kind"))) boxes++;
                    else rings++;
                }
                String silverText = boxes + " Box  |  " + rings + " Ring";
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation ||
                            !token.equals(sessions.load())) return;
                    availableEru = snapshot.eru;
                    sol.setText(snapshot.sol);
                    eru.setText(snapshot.eru);
                    silver.setText(silverText);
                    send.setEnabled(canSend);
                    sendState.setText(waiting ? "Previous transfer still settling. View activity." :
                            canSend ? "Review each transfer before signing." :
                                    "No ERU available to send.");
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation) return;
                    availableEru = null;
                    sol.setText("Unavailable");
                    eru.setText("Unavailable");
                    silver.setText("Unavailable");
                });
            }
        });
    }

    private void receive() {
        page("Receive");
        label("Solana Devnet", 15);
        try {
            BitMatrix qr = WalletQr.encodeAddress(localAddress, 320);
            int[] pixels = new int[qr.getWidth() * qr.getHeight()];
            for (int y = 0; y < qr.getHeight(); y++) {
                for (int x = 0; x < qr.getWidth(); x++) {
                    pixels[y * qr.getWidth() + x] = qr.get(x, y) ? 0xff171717 : 0xffffffff;
                }
            }
            ImageView image = new ImageView(this);
            image.setImageBitmap(Bitmap.createBitmap(pixels, qr.getWidth(), qr.getHeight(),
                    Bitmap.Config.ARGB_8888));
            content.addView(image, new LinearLayout.LayoutParams(-1, dp(270)));
        } catch (Exception ignored) {
            label("QR unavailable", 15);
        }
        TextView address = label(localAddress, 16);
        address.setGravity(Gravity.CENTER);
        address.setTextIsSelectable(true);
        primaryButton("Copy address").setOnClickListener(view -> copyAddress());
    }

    private <T> void work(Button action, Callable<T> task, Consumer<T> done) {
        int request = generation;
        action.setEnabled(false);
        feedback.setText("");
        io.execute(() -> {
            try {
                T value = task.call();
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation) {
                        if (value instanceof AutoCloseable) {
                            try { ((AutoCloseable) value).close(); }
                            catch (Exception ignored) { }
                        }
                        return;
                    }
                    action.setEnabled(true);
                    done.accept(value);
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || request != generation) return;
                    action.setEnabled(true);
                    feedback.setText("Wallet request failed. Check account, connection and try again.");
                });
            }
        });
    }

    private void create() {
        page("Create Wallet");
        label("Your keys stay on this device. Save your recovery phrase privately; EtheRings cannot recover it.", 16);
        Button action = primaryButton("Create new wallet");
        action.setOnClickListener(view -> work(action, wallet::generate, creation -> {
            pendingCreation = creation;
            backup(creation);
        }));
    }

    private void backup(AlphaWallet.Creation creation) {
        page("Recovery phrase");
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        label("Write these words down in order and keep them private.", 15);
        char[] words = creation.recoveryPhrase();
        try {
            TextView phrase = label(new String(words), 18);
            phrase.setPadding(dp(16), dp(18), dp(16), dp(18));
            phrase.setBackground(AlphaUi.shape(this, R.color.brand_surface_elevated, true));
        }
        finally { Arrays.fill(words, '\0'); }
        CheckBox saved = new CheckBox(this);
        saved.setText("I saved this phrase privately");
        content.addView(saved);
        Button confirm = primaryButton("Finish wallet setup");
        confirm.setEnabled(false);
        saved.setOnCheckedChangeListener((view, checked) -> confirm.setEnabled(checked));
        confirm.setOnClickListener(view -> work(confirm, () -> {
            wallet.persist(creation);
            selection.save(accountId, creation.address);
            return true;
        }, ignored -> {
            discardCreation();
            refresh();
        }));
    }

    private void discardCreation() {
        if (pendingCreation != null) {
            pendingCreation.close();
            pendingCreation = null;
        }
    }

    private void restore() {
        page("Restore Wallet");
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        label("Enter your recovery phrase on this device only.", 16);
        EditText input = AlphaUi.field(this, "Recovery phrase", InputType.TYPE_CLASS_TEXT);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD |
                InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setMinLines(3);
        input.setSingleLine(false);
        input.setGravity(Gravity.TOP);
        input.setPadding(dp(14), dp(14), dp(14), dp(14));
        content.addView(input, new LinearLayout.LayoutParams(-1, dp(120)));
        Button action = primaryButton("Restore wallet");
        action.setOnClickListener(view -> {
            char[] phrase = input.getText().toString().trim().toCharArray();
            input.setText("");
            if (phrase.length == 0) { feedback.setText("Enter the recovery phrase."); return; }
            String expectedAccount = accountId;
            String expectedToken = sessions.load();
            work(action, () -> {
                try {
                    if (expectedToken == null || !expectedToken.equals(sessions.load()))
                        throw new IllegalArgumentException("Session changed");
                    String restored = wallet.restoreFromMnemonic(phrase);
                    selection.save(expectedAccount, restored);
                    return restored;
                }
                finally { Arrays.fill(phrase, '\0'); }
            }, ignored -> refresh());
        });
    }

    private void switchWallet() {
        if (localAddress == null) return;
        String account = accountId;
        String address = localAddress;
        String bound = boundAddress;
        String token = sessions.load();
        page("Use a different wallet");
        label("This removes its recovery phrase from this device only. Its account connection and on-chain assets remain unchanged. You will need the saved recovery phrase to use it again.", 15);
        Button remove = primaryButton("Remove local wallet");
        remove.setOnClickListener(view -> work(remove, () -> {
            if (token == null || !token.equals(sessions.load()) || !address.equals(wallet.address()))
                throw new IllegalArgumentException("Session or wallet changed");
            AlphaAuthApi.Result me = api.get("/auth/me", token);
            AlphaAuthApi.Result binding = api.get("/wallet", token);
            if (me.status != 200 || binding.status != 200 ||
                    !account.equals(me.body.getString("id")) ||
                    !bound.equals(binding.body.isNull("walletAddress") ? "" :
                            binding.body.getString("walletAddress")))
                throw new IllegalArgumentException("Account binding changed");
            wallet.delete();
            selection.clear();
            return true;
        }, ignored -> refresh()));
        button("Cancel").setOnClickListener(view -> refresh());
    }

    private void requestBinding() {
        if (localAddress == null || !boundAddress.isEmpty() ||
                !selection.matches(accountId, localAddress)) return;
        page("Connect wallet");
        label("Connect this wallet to your verified EtheRings account. This does not move funds.", 16);
        TextView addressText = label(localAddress, 16);
        addressText.setTextIsSelectable(true);
        Button action = primaryButton("Review connection");
        String account = accountId;
        String address = localAddress;
        String token = sessions.load();
        work(action, () -> {
            requireCurrentAccount(token, account, address, true);
            JSONObject body = new JSONObject().put("walletAddress", address);
            AlphaAuthApi.Result result = api.post("/wallet/challenge", body, token);
            if (result.status != 200) throw new IllegalStateException("Challenge unavailable");
            return BindingChallenge.decode(result.body.getString("messageBase64"),
                    result.body.getString("nonce"), result.body.getLong("expiresAtMs"),
                    account, address, BuildConfig.ALPHA_BINDING_ENVIRONMENT,
                    System.currentTimeMillis());
        }, challenge -> confirmBinding(challenge, token));
    }

    private void requireCurrentAccount(String token, String account, String address,
            boolean expectUnbound) throws Exception {
        if (token == null || !token.equals(sessions.load()) || !address.equals(wallet.address()))
            throw new IllegalArgumentException("Session or wallet changed");
        AlphaAuthApi.Result me = api.get("/auth/me", token);
        AlphaAuthApi.Result current = api.get("/wallet", token);
        if (me.status != 200 || current.status != 200 ||
                !account.equals(me.body.getString("id")) ||
                (expectUnbound ? !current.body.isNull("walletAddress") :
                        !address.equals(current.body.getString("walletAddress"))))
            throw new IllegalArgumentException("Account or binding changed");
    }

    private void confirmBinding(BindingChallenge challenge, String token) {
        page("Confirm wallet connection");
        label("Account: " + accountEmail, 15);
        label("Wallet: " + AlphaUi.shortAddress(challenge.walletAddress), 16);
        label("Your wallet stays on this device. Connecting it does not transfer or spend funds.", 15);
        Button confirm = primaryButton("Connect wallet");
        confirm.setOnClickListener(view -> work(confirm, () -> {
            requireCurrentAccount(token, challenge.accountId, challenge.walletAddress, true);
            if (challenge.expiresAtMs <= System.currentTimeMillis())
                throw new IllegalArgumentException("Challenge expired");
            byte[] message = challenge.message();
            byte[] signature = wallet.signBinding(challenge, challenge.accountId,
                    BuildConfig.ALPHA_BINDING_ENVIRONMENT);
            try {
                JSONObject body = new JSONObject().put("nonce", challenge.nonce)
                        .put("walletAddress", challenge.walletAddress)
                        .put("messageBase64", Base64.getEncoder().encodeToString(message))
                        .put("signatureBase64", Base64.getEncoder().encodeToString(signature));
                return api.post("/wallet/bind", body, token);
            } finally { Arrays.fill(signature, (byte) 0); }
        }, result -> {
            if (result.status == 200) refresh();
            else feedback.setText("Binding rejected or challenge already used. Return and retry.");
        }));
        button("Cancel").setOnClickListener(view -> refresh());
    }
}
