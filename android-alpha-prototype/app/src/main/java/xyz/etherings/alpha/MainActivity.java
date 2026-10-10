package xyz.etherings.alpha;

import android.app.Activity;
import android.os.Bundle;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private enum Screen { REGISTER, VERIFY, LOGIN, HOME }
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private AlphaApi api;
    private AlphaSessionStore sessions;
    private EruOperationStore operations;
    private AlphaWallet wallet;
    private final android.os.Handler refreshHandler = new android.os.Handler(Looper.getMainLooper());
    private Runnable refreshTask;
    private LinearLayout content;
    private TextView feedback;
    private Screen screen = Screen.REGISTER;
    private String email = "";
    private String activeEmail = "";
    private String activeAccountId = "";
    private AlphaWallet.Creation pendingCreation;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!BuildConfig.DEBUG) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        sessions = new AlphaSessionStore(this);
        operations = new EruOperationStore(this);
        wallet = new AlphaWallet(this);
        try { api = new AlphaApi(BuildConfig.ALPHA_API_BASE_URL); }
        catch (IllegalArgumentException ignored) { api = null; }
        if (api == null) { shell("Alpha service unavailable"); return; }
        String saved = sessions.load();
        if (saved == null) register();
        else { shell("Restoring session..."); checkSession(saved); }
    }

    @Override protected void onDestroy() {
        cancelOperationRefresh();
        if (pendingCreation != null) pendingCreation.close();
        io.shutdownNow();
        super.onDestroy();
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void shell(String title) {
        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(28), dp(24), dp(32));
        scroll.addView(content);
        setContentView(scroll);
        TextView brand = new TextView(this);
        brand.setText("EtheRings Alpha");
        brand.setTextSize(22);
        brand.setTextColor(0xff123d39);
        content.addView(brand);
        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextSize(19);
        heading.setTextColor(0xff202a2b);
        heading.setPadding(0, dp(28), 0, dp(12));
        content.addView(heading);
        feedback = new TextView(this);
        feedback.setTextColor(0xffa53b25);
        feedback.setTextSize(14);
        feedback.setMinHeight(dp(28));
        content.addView(feedback);
    }

    private EditText field(String hint, int type) {
        EditText edit = new EditText(this);
        edit.setSingleLine(true);
        edit.setHint(hint);
        edit.setInputType(type);
        edit.setTextSize(16);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(56));
        params.bottomMargin = dp(12);
        content.addView(edit, params);
        return edit;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(48));
        params.bottomMargin = dp(8);
        content.addView(button, params);
        return button;
    }

    private JSONObject body(String key1, String value1, String key2, String value2) throws Exception {
        JSONObject json = new JSONObject();
        json.put(key1, value1);
        if (key2 != null) json.put(key2, value2);
        return json;
    }

    private interface Handler { void accept(AlphaApi.Result result) throws Exception; }
    private void submit(Button command, Callable<AlphaApi.Result> request, Handler handler) {
        command.setEnabled(false);
        feedback.setText("");
        io.execute(() -> {
            try {
                AlphaApi.Result result = request.call();
                runOnUiThread(() -> {
                    command.setEnabled(true);
                    try { handler.accept(result); }
                    catch (Exception ignored) { feedback.setText("Request could not be completed."); }
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> { command.setEnabled(true); feedback.setText("Dev connection unavailable. Try again."); });
            }
        });
    }

    private void error(int status) {
        if (status == 429) feedback.setText("Too many attempts. Please wait before retrying.");
        else if (status == 400 && screen == Screen.VERIFY)
            feedback.setText("Code is incorrect, expired or already used. Check it or request a new code.");
        else if (status == 401) feedback.setText("Email/password not accepted, or email not verified yet.");
        else feedback.setText("Request could not be completed. Try again.");
    }

    private void register() {
        screen = Screen.REGISTER;
        shell("Create account");
        EditText address = field("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        address.setText(email);
        EditText password = field("Password (8+ characters)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        Button action = button("Register");
        action.setOnClickListener(view -> {
            String inputEmail = address.getText().toString().trim();
            String inputPassword = password.getText().toString();
            if (inputEmail.isEmpty() || inputPassword.length() < 8) {
                feedback.setText("Enter an email and a password of at least 8 characters."); return;
            }
            submit(action, () -> api.post("/auth/register", body("email", inputEmail, "password", inputPassword), null), result -> {
                password.setText("");
                if (result.status == 202) { email = inputEmail; verify(); }
                else error(result.status);
            });
        });
        button("I have a code").setOnClickListener(view -> { email = address.getText().toString().trim(); verify(); });
        button("Log in").setOnClickListener(view -> { email = address.getText().toString().trim(); login(); });
    }

    private void verify() {
        screen = Screen.VERIFY;
        shell("Verify email");
        EditText address = field("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        address.setText(email);
        EditText code = field("4-digit code", InputType.TYPE_CLASS_NUMBER);
        Button action = button("Verify");
        action.setOnClickListener(view -> {
            String inputEmail = address.getText().toString().trim();
            String inputCode = code.getText().toString().trim();
            if (!inputCode.matches("[0-9]{4}")) { feedback.setText("Enter the 4-digit code."); return; }
            submit(action, () -> api.post("/auth/verify", body("email", inputEmail, "code", inputCode), null), result -> {
                if (result.status == 200) {
                    email = inputEmail;
                    code.setText("");
                    acceptSession(result.body.getString("accessToken"));
                } else error(result.status);
            });
        });
        Button resend = button("Resend code");
        resend.setOnClickListener(view -> {
            String inputEmail = address.getText().toString().trim();
            submit(resend, () -> api.post("/auth/resend", body("email", inputEmail, null, null), null), result -> {
                if (result.status == 202) feedback.setText("If eligible, a new code has been sent.");
                else error(result.status);
            });
        });
        button("Log in").setOnClickListener(view -> login());
    }

    private void login() {
        screen = Screen.LOGIN;
        shell("Log in");
        EditText address = field("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        address.setText(email);
        EditText password = field("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        Button action = button("Log in");
        action.setOnClickListener(view -> {
            String inputEmail = address.getText().toString().trim();
            String inputPassword = password.getText().toString();
            submit(action, () -> api.post("/auth/login", body("email", inputEmail, "password", inputPassword), null), result -> {
                password.setText("");
                if (result.status == 200) { email = inputEmail; acceptSession(result.body.getString("accessToken")); }
                else error(result.status);
            });
        });
        button("Create account").setOnClickListener(view -> register());
        button("Verify email").setOnClickListener(view -> { email = address.getText().toString().trim(); verify(); });
    }

    private void acceptSession(String token) {
        try { sessions.save(token); shell("Checking account..."); checkSession(token); }
        catch (Exception ignored) { sessions.clear(); feedback.setText("Secure session storage unavailable."); }
    }

    private void checkSession(String token) {
        io.execute(() -> {
            try {
                AlphaApi.Result result = api.get("/auth/me", token);
                runOnUiThread(() -> {
                    if (result.status == 200) {
                        activeEmail = result.body.optString("email", "");
                        activeAccountId = result.body.optString("id", "");
                        home();
                    }
                    else { sessions.clear(); login(); }
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    feedback.setText("Dev connection unavailable.");
                    button("Retry").setOnClickListener(view -> {
                        shell("Restoring session...");
                        checkSession(token);
                    });
                });
            }
        });
    }

    private void home() {
        cancelOperationRefresh();
        screen = Screen.HOME;
        shell("Account verified");
        TextView loading = new TextView(this);
        loading.setText("Loading wallet status...");
        content.addView(loading);
        loadWalletState();
    }

    private void loadWalletState() {
        String account = activeAccountId;
        String token = sessions.load();
        if (token == null) { login(); return; }
        io.execute(() -> {
            try {
                String local = wallet.exists() ? wallet.address() : null;
                AlphaApi.Result result = api.get("/wallet", token);
                runOnUiThread(() -> {
                    if (screen != Screen.HOME || !account.equals(activeAccountId)) return;
                    if (result.status == 200) showWallet(local, result.body.isNull("walletAddress")
                            ? "" : result.body.optString("walletAddress", ""));
                    else { shell("Account verified"); feedback.setText("Wallet status unavailable."); logoutButton(); }
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (screen != Screen.HOME || !account.equals(activeAccountId)) return;
                    shell("Account verified");
                    feedback.setText("Wallet status unavailable. Check the dev connection.");
                    button("Retry").setOnClickListener(view -> home());
                    logoutButton();
                });
            }
        });
    }

    private void showWallet(String local, String bound) {
        shell("Account verified");
        TextView identity = new TextView(this);
        identity.setText(activeEmail);
        identity.setTextSize(16);
        identity.setPadding(0, 0, 0, dp(16));
        content.addView(identity);
        TextView status = new TextView(this);
        status.setText(bound.isEmpty() ? "Wallet not bound" : "Wallet bound: " + bound);
        status.setTextSize(15);
        content.addView(status);
        if (local != null) {
            TextView address = new TextView(this);
            address.setText("On this device: " + local);
            address.setTextSize(15);
            address.setPadding(0, dp(12), 0, dp(16));
            content.addView(address);
            if (bound.isEmpty()) {
                Button bind = button("Bind wallet");
                bind.setOnClickListener(view -> requestBinding(bind, local));
            }
            else if (!bound.equals(local)) feedback.setText("This account is bound to a different wallet. Restore its phrase on this device.");
            else {
                if (BuildConfig.DEBUG) {
                    TextView silverInventory = new TextView(this);
                    silverInventory.setText("Silver inventory: not loaded");
                    silverInventory.setPadding(0, dp(8), 0, dp(8));
                    content.addView(silverInventory);
                    Button refreshSilver = button("Refresh Silver inventory");
                    refreshSilver.setOnClickListener(view ->
                            refreshSilverInventory(refreshSilver, silverInventory));
                }
                if (BuildConfig.DEBUG && !BuildConfig.ALPHA_SILVER_POLICY_B64.isEmpty() &&
                        !BuildConfig.ALPHA_SILVER_GENESIS_HASH.isEmpty())
                    button("Review Silver Box opening").setOnClickListener(
                            view -> reviewSilverOpening(bound));
                if (BuildConfig.DEBUG && !BuildConfig.ALPHA_SILVER_POLICY_B64.isEmpty() &&
                        getIntent().getStringExtra("silverMessageBase64") != null)
                    button("Review Silver transfer").setOnClickListener(
                            view -> reviewSilverProof(bound));
                EruOperationStore.Operation operation = operations.load(activeAccountId, bound, "devnet");
                if (operation != null) {
                    TextView operationStatus = new TextView(this);
                    operationStatus.setText("ERU operation: " + operation.status);
                    operationStatus.setTextSize(16);
                    content.addView(operationStatus);
                    button("Refresh ERU status").setOnClickListener(view -> refreshOperation(operation));
                    if ("pending".equals(operation.status) || "unknown".equals(operation.status))
                        scheduleOperationRefresh(operation, 3_000);
                } else if (BuildConfig.DEBUG && !BuildConfig.ALPHA_GATEWAY_POLICY_B64.isEmpty()) {
                    button("Review ERU transfer").setOnClickListener(view -> reviewEruProof(bound));
                }
            }
        } else if (bound.isEmpty()) {
            button("Create Wallet").setOnClickListener(view -> createWallet());
            button("Restore Wallet").setOnClickListener(view -> restoreWallet());
        } else {
            button("Restore Wallet").setOnClickListener(view -> restoreWallet());
        }
        logoutButton();
    }

    private void refreshSilverInventory(Button refresh, TextView result) {
        String account = activeAccountId;
        String token = sessions.load();
        if (token == null) { login(); return; }
        refresh.setEnabled(false);
        io.execute(() -> {
            String display;
            try {
                AlphaApi.Result response = api.get("/silver/inventory", token);
                if (response.status != 200) display = "Silver inventory unavailable (" + response.status + ")";
                else {
                    JSONArray assets = response.body.getJSONArray("assets");
                    StringBuilder lines = new StringBuilder("Silver inventory: " + assets.length());
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.getJSONObject(i);
                        lines.append('\n').append(asset.optString("kind"));
                        if (asset.has("designId")) lines.append(" #").append(asset.optInt("designId"));
                        lines.append('\n').append(asset.optString("mintAddress"));
                    }
                    display = lines.toString();
                }
            } catch (Exception ignored) { display = "Silver inventory unavailable"; }
            String value = display;
            runOnUiThread(() -> {
                if (screen != Screen.HOME || !account.equals(activeAccountId)) return;
                result.setText(value);
                refresh.setEnabled(true);
            });
        });
    }

    private void createWallet() {
        shell("Create Wallet");
        TextView warning = new TextView(this);
        warning.setText("Save your recovery phrase privately. It cannot be recovered by EtheRings.");
        content.addView(warning);
        Button action = button("Create new wallet");
        action.setOnClickListener(view -> submit(action, () -> {
            AlphaWallet.Creation creation = wallet.generate();
            runOnUiThread(() -> {
                pendingCreation = creation;
                showRecoveryPhrase(creation);
            });
            return new AlphaApi.Result(200, new JSONObject());
        }, result -> {}));
    }

    private void showRecoveryPhrase(AlphaWallet.Creation creation) {
        shell("Recovery phrase");
        char[] words = creation.recoveryPhrase();
        TextView phrase = new TextView(this);
        try { phrase.setText(new String(words)); }
        finally { Arrays.fill(words, '\0'); }
        phrase.setTextSize(18);
        phrase.setTextIsSelectable(false);
        phrase.setPadding(0, dp(16), 0, dp(16));
        content.addView(phrase);
        TextView note = new TextView(this);
        note.setText("Write this phrase down offline. Never share it. Screenshots are blocked.");
        content.addView(note);
        Button saved = button("I saved the phrase");
        saved.setOnClickListener(view -> submit(saved, () -> {
            wallet.persist(creation);
            return new AlphaApi.Result(200, new JSONObject());
        }, result -> {
            creation.close();
            pendingCreation = null;
            home();
        }));
    }

    private void restoreWallet() {
        shell("Restore Wallet");
        TextView note = new TextView(this);
        note.setText("Enter your BIP-39 phrase on this device only. It is never sent to the server.");
        content.addView(note);
        EditText phrase = field("Recovery phrase", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        phrase.setSingleLine(false);
        phrase.setMinLines(3);
        phrase.getLayoutParams().height = dp(120);
        phrase.requestLayout();
        Button action = button("Restore wallet");
        action.setOnClickListener(view -> {
            char[] words = phrase.getText().toString().trim().toCharArray();
            phrase.setText("");
            if (words.length == 0) { feedback.setText("Enter the recovery phrase."); return; }
            submit(action, () -> {
                try { return new AlphaApi.Result(200, new JSONObject().put("address", wallet.restore(words))); }
                finally { Arrays.fill(words, '\0'); }
            }, result -> home());
        });
    }

    private void requestBinding(Button action, String local) {
        submit(action,
                () -> api.post("/wallet/challenge", new JSONObject().put("walletAddress", local), sessions.load()),
                result -> {
                    if (result.status != 200) {
                        if (result.status == 409) feedback.setText("This account already has a bound wallet.");
                        else error(result.status);
                        return;
                    }
                    try {
                        BindingChallenge challenge = BindingChallenge.decode(
                                result.body.getString("messageBase64"), result.body.getString("nonce"),
                                result.body.getLong("expiresAtMs"), activeAccountId,
                                local, BuildConfig.ALPHA_BINDING_ENVIRONMENT, System.currentTimeMillis());
                        confirmBinding(challenge);
                    } catch (Exception ignored) { feedback.setText("Binding challenge failed local validation."); }
                });
    }

    private void confirmBinding(BindingChallenge challenge) {
        shell("Confirm wallet binding");
        TextView intent = new TextView(this);
        intent.setText("Bind Solana wallet " + challenge.walletAddress + " to this EtheRings Alpha account on " +
                challenge.environment + ". This is not a transfer or spend.");
        intent.setTextSize(16);
        intent.setPadding(0, 0, 0, dp(16));
        content.addView(intent);
        Button confirm = button("Confirm binding");
        confirm.setOnClickListener(view -> submit(confirm, () -> {
            byte[] signature = wallet.signBinding(challenge, activeAccountId,
                    BuildConfig.ALPHA_BINDING_ENVIRONMENT);
            try {
                JSONObject body = new JSONObject().put("nonce", challenge.nonce)
                        .put("walletAddress", challenge.walletAddress)
                        .put("messageBase64", Base64.getEncoder().encodeToString(challenge.message()))
                        .put("signatureBase64", Base64.getEncoder().encodeToString(signature));
                return api.post("/wallet/bind", body, sessions.load());
            } finally { Arrays.fill(signature, (byte) 0); }
        }, result -> {
            if (result.status == 200) home();
            else if (result.status == 409) feedback.setText("Binding unavailable or challenge already used. Return and try again.");
            else error(result.status);
        }));
        button("Cancel").setOnClickListener(view -> home());
    }

    private void logoutButton() {
        Button action = button("Log out");
        action.setOnClickListener(view -> {
            String token = sessions.load();
            sessions.clear();
            cancelOperationRefresh();
            activeEmail = "";
            activeAccountId = "";
            login();
            if (token == null) return;
            io.execute(() -> {
                boolean revoked;
                try {
                    AlphaApi.Result result = api.post("/auth/logout", null, token);
                    revoked = result.status == 204 || result.status == 401;
                } catch (Exception ignored) { revoked = false; }
                if (!revoked) runOnUiThread(() -> {
                    if (screen == Screen.LOGIN)
                        feedback.setText("Signed out on this device; server sign-out could not be confirmed.");
                });
            });
        });
    }

    private void reviewEruProof(String boundAddress) {
        shell("Checking ERU intent...");
        String token = sessions.load();
        String account = activeAccountId;
        io.execute(() -> {
            try {
                if (token == null || !token.equals(sessions.load()) || !wallet.address().equals(boundAddress))
                    throw new IllegalArgumentException("Wallet or session changed");
                AlphaApi.Result me = api.get("/auth/me", token);
                AlphaApi.Result binding = api.get("/wallet", token);
                if (me.status != 200 || binding.status != 200 ||
                        !account.equals(me.body.getString("id")) ||
                        !boundAddress.equals(binding.body.getString("walletAddress")))
                    throw new IllegalArgumentException("Wallet is not bound to current account");
                byte[] policyBytes = Base64.getDecoder().decode(BuildConfig.ALPHA_GATEWAY_POLICY_B64);
                GatewayMessagePolicy policy = new GatewayMessagePolicy(
                        new JSONObject(new String(policyBytes, StandardCharsets.UTF_8)));
                if (!boundAddress.equals(policy.authority()))
                    throw new IllegalArgumentException("Pinned policy wallet mismatch");
                AlphaApi.Result issued = api.post("/eru/intent", new JSONObject(), token);
                if (issued.status != 200) throw new IllegalArgumentException("ERU intent unavailable");
                JSONObject request = issued.body;
                if (!policy.cluster().equals(request.getString("cluster")))
                    throw new IllegalArgumentException("ERU intent cluster mismatch");
                byte[] message = Base64.getDecoder().decode(request.getString("message"));
                GatewayMessagePolicy.Decoded decoded = verifyEruIntent(policy, message);
                EruOperationStore.Operation operation = new EruOperationStore.Operation(
                        request.getString("id"), account, boundAddress, policy.cluster(), "pending");
                operations.save(operation);
                runOnUiThread(() -> showEruConfirmation(policy, decoded, request.optString("id"),
                        boundAddress, token, account));
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    shell("ERU intent rejected");
                    feedback.setText("The wallet, account or transaction intent could not be verified.");
                    button("Back").setOnClickListener(view -> home());
                });
            }
        });
    }

    private void requireSilverOpeningAccount(String session, String account,
            String boundAddress) throws Exception {
        if (screen != Screen.HOME || !session.equals(sessions.load()) ||
                !account.equals(activeAccountId) || !boundAddress.equals(wallet.address()))
            throw new IllegalArgumentException("Silver opening account changed");
        AlphaApi.Result me = api.get("/auth/me", session);
        AlphaApi.Result binding = api.get("/wallet", session);
        if (me.status != 200 || binding.status != 200 ||
                !account.equals(me.body.getString("id")) ||
                !boundAddress.equals(binding.body.getString("walletAddress")))
            throw new IllegalArgumentException("Silver opening wallet is not bound");
    }

    private void reviewSilverOpening(String boundAddress) {
        String session = sessions.load();
        String account = activeAccountId;
        if (session == null) { login(); return; }
        shell("Checking Silver Box opening...");
        io.execute(() -> {
            try {
                requireSilverOpeningAccount(session, account, boundAddress);
                byte[] bytes = Base64.getDecoder().decode(BuildConfig.ALPHA_SILVER_POLICY_B64);
                SilverOpeningPolicy policy = new SilverOpeningPolicy(
                        new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
                if (!boundAddress.equals(policy.value("authority")))
                    throw new IllegalArgumentException("Pinned Silver owner mismatch");
                AlphaApi.Result issued = api.post("/silver/opening/candidate-intent",
                        new JSONObject().put("mintAddress", policy.value("mint")), session);
                if (issued.status != 200)
                    throw new IllegalArgumentException("Silver opening candidate unavailable");
                SilverOpeningPolicy.Decoded decoded = policy.validateResponse(issued.body);
                SilverOpeningChainClock clock = new SilverOpeningChainClock(
                        BuildConfig.ALPHA_SILVER_RPC_URL);
                clock.requireCurrent(policy, decoded,
                        issued.body.getLong("lastValidBlockHeight"));
                runOnUiThread(() -> {
                    if (!session.equals(sessions.load()) || !account.equals(activeAccountId)) {
                        home(); return;
                    }
                    try {
                        SilverOpeningApprovalDialog.show(this, issued.body, policy, clock,
                                wallet, boundAddress,
                                () -> requireSilverOpeningAccount(session, account, boundAddress),
                                signed -> {
                                    if (!session.equals(sessions.load()) ||
                                            !account.equals(activeAccountId)) return;
                                    shell(signed ? "Silver opening signed locally" :
                                            "Silver opening not signed");
                                    if (signed) feedback.setText("No opening transaction was submitted.");
                                    button("Back").setOnClickListener(view -> home());
                                });
                    } catch (Exception ignored) {
                        if (!session.equals(sessions.load()) ||
                                !account.equals(activeAccountId)) return;
                        shell("Silver opening rejected");
                        button("Back").setOnClickListener(view -> home());
                    }
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (!session.equals(sessions.load()) ||
                            !account.equals(activeAccountId)) return;
                    shell("Silver opening unavailable");
                    feedback.setText("The account, wallet, pinned intent or chain state could not be verified.");
                    button("Back").setOnClickListener(view -> home());
                });
            }
        });
    }

    private void reviewSilverProof(String boundAddress) {
        shell("Checking Silver transfer...");
        String session = sessions.load();
        String account = activeAccountId;
        io.execute(() -> {
            try {
                if (session == null || !session.equals(sessions.load()) ||
                        !wallet.address().equals(boundAddress))
                    throw new IllegalArgumentException("Wallet or session changed");
                AlphaApi.Result me = api.get("/auth/me", session);
                AlphaApi.Result binding = api.get("/wallet", session);
                if (me.status != 200 || binding.status != 200 ||
                        !account.equals(me.body.getString("id")) ||
                        !boundAddress.equals(binding.body.getString("walletAddress")))
                    throw new IllegalArgumentException("Bound account mismatch");
                byte[] bytes = Base64.getDecoder().decode(BuildConfig.ALPHA_SILVER_POLICY_B64);
                SilverTransferPolicy policy = new SilverTransferPolicy(
                        new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
                if (!boundAddress.equals(policy.authority()))
                    throw new IllegalArgumentException("Pinned Silver owner mismatch");
                byte[] message = Base64.getDecoder().decode(
                        getIntent().getStringExtra("silverMessageBase64"));
                SilverTransferPolicy.Decoded decoded = policy.validate(message);
                DevnetIntentClock clock = new DevnetIntentClock(BuildConfig.ALPHA_SILVER_RPC_URL);
                clock.confirmedSlot();
                clock.requireFreshBlockhash(decoded.blockhash,
                        getIntent().getLongExtra("silverContextSlot", 0));
                runOnUiThread(() -> showSilverConfirmation(policy, decoded,
                        boundAddress, session, account));
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    shell("Silver transfer rejected");
                    feedback.setText("The account, wallet or transfer bytes could not be verified.");
                    button("Back").setOnClickListener(view -> home());
                });
            }
        });
    }

    private void showSilverConfirmation(SilverTransferPolicy policy,
            SilverTransferPolicy.Decoded decoded, String boundAddress,
            String session, String account) {
        if (!session.equals(sessions.load()) || !account.equals(activeAccountId)) {
            home(); return;
        }
        shell("Confirm Silver transfer");
        TextView details = new TextView(this);
        details.setText("1 Silver Box\nDestination token account: " + decoded.destination +
                "\nNetwork fee: Devnet SOL");
        details.setTextSize(16);
        details.setPadding(0, 0, 0, dp(18));
        content.addView(details);
        Button confirm = button("Sign Silver transfer");
        confirm.setOnClickListener(view -> submit(confirm, () -> {
            try {
                if (!session.equals(sessions.load()) || !account.equals(activeAccountId))
                    throw new IllegalArgumentException("Session changed");
                AlphaApi.Result me = api.get("/auth/me", session);
                AlphaApi.Result binding = api.get("/wallet", session);
                if (me.status != 200 || binding.status != 200 ||
                        !account.equals(me.body.getString("id")) ||
                        !boundAddress.equals(binding.body.getString("walletAddress")))
                    throw new IllegalArgumentException("Bound account changed");
                SilverTransferPolicy.Decoded checked = policy.validate(decoded.message());
                DevnetIntentClock clock = new DevnetIntentClock(BuildConfig.ALPHA_SILVER_RPC_URL);
                clock.confirmedSlot();
                clock.requireFreshBlockhash(checked.blockhash,
                        getIntent().getLongExtra("silverContextSlot", 0));
                byte[] signature = wallet.signSilver(checked, boundAddress);
                try {
                    JSONObject proof = new JSONObject();
                    proof.put("messageBase64", Base64.getEncoder().encodeToString(checked.message()));
                    proof.put("signatureBase64", Base64.getEncoder().encodeToString(signature));
                    try (OutputStream output = openFileOutput(
                            "silver-proof-signature.json", MODE_PRIVATE)) {
                        output.write(proof.toString().getBytes(StandardCharsets.UTF_8));
                    }
                    return new AlphaApi.Result(200, new JSONObject());
                } finally { Arrays.fill(signature, (byte) 0); }
            } catch (Exception ignored) {
                return new AlphaApi.Result(422, new JSONObject());
            }
        }, result -> {
            if (result.status != 200) {
                feedback.setText("Silver signing rejected. Review a fresh transfer intent.");
                return;
            }
            shell("Silver transfer signed");
            button("Back").setOnClickListener(back -> home());
        }));
        button("Cancel").setOnClickListener(view -> home());
    }

    private void showEruConfirmation(GatewayMessagePolicy policy,
            GatewayMessagePolicy.Decoded decoded, String intentId,
            String boundAddress, String token, String account) {
        if (!token.equals(sessions.load()) || !account.equals(activeAccountId)) { home(); return; }
        cancelOperationRefresh();
        shell("Confirm ERU transfer");
        TextView details = new TextView(this);
        details.setText("Amount: " + eru(decoded.amountBaseUnits) + " ERU\nDestination: " +
                decoded.destination + "\nPlatform fee: " + eru(decoded.feeBaseUnits) +
                " ERU\nTreasury: " + decoded.treasury + "\nTotal debit: " +
                eru(decoded.amountBaseUnits + decoded.feeBaseUnits) + " ERU");
        details.setTextSize(16);
        details.setPadding(0, 0, 0, dp(18));
        content.addView(details);
        Button confirm = button("Sign ERU transfer");
        confirm.setOnClickListener(view -> submit(confirm, () -> {
            if (!token.equals(sessions.load()) || !account.equals(activeAccountId))
                throw new IllegalArgumentException("Session changed");
            AlphaApi.Result me = api.get("/auth/me", token);
            AlphaApi.Result current = api.get("/wallet", token);
            if (me.status != 200 || current.status != 200 ||
                    !account.equals(me.body.getString("id")) ||
                    !boundAddress.equals(current.body.getString("walletAddress")))
                throw new IllegalArgumentException("Bound wallet changed");
            GatewayMessagePolicy.Decoded rechecked = verifyEruIntent(policy, decoded.message());
            byte[] signature = wallet.signGateway(rechecked, boundAddress);
            try {
                operations.save(new EruOperationStore.Operation(intentId, account,
                        boundAddress, policy.cluster(), "unknown"));
                JSONObject submission = new JSONObject();
                submission.put("id", intentId);
                submission.put("signatureBase64", Base64.getEncoder().encodeToString(signature));
                try { return api.post("/eru/submit", submission, token); }
                catch (Exception ignored) {
                    return new AlphaApi.Result(503, new JSONObject().put("status", "unknown"));
                }
            } finally { Arrays.fill(signature, (byte) 0); }
        }, result -> {
            String status = nextOperationStatus("unknown", result);
            if (status != null) operations.save(new EruOperationStore.Operation(
                    intentId, account, boundAddress, policy.cluster(), status));
            home();
        }));
        button("Cancel").setOnClickListener(view -> home());
    }

    static String operationStatus(AlphaApi.Result result) {
        String status = result.body.optString("status", "");
        if (result.status == 200 && ("confirmed".equals(status) || "pending".equals(status)))
            return status;
        if (result.status == 409 && "failed".equals(status)) return status;
        if (result.status == 503 && "unknown".equals(status)) return status;
        return null;
    }

    static String nextOperationStatus(String current, AlphaApi.Result response) {
        String reported = response == null ? null : operationStatus(response);
        if (reported == null || "confirmed".equals(current) || "failed".equals(current) ||
                ("unknown".equals(current) && "pending".equals(reported))) return current;
        return reported;
    }

    private void cancelOperationRefresh() {
        if (refreshTask != null) refreshHandler.removeCallbacks(refreshTask);
        refreshTask = null;
    }

    private void scheduleOperationRefresh(EruOperationStore.Operation operation, long delayMs) {
        cancelOperationRefresh();
        refreshTask = () -> refreshOperation(operation);
        refreshHandler.postDelayed(refreshTask, delayMs);
    }

    private void refreshOperation(EruOperationStore.Operation operation) {
        cancelOperationRefresh();
        String token = sessions.load();
        if (token == null || screen != Screen.HOME ||
                !operation.account.equals(activeAccountId) ||
                operations.load(operation.account, operation.wallet, operation.cluster) == null) return;
        io.execute(() -> {
            AlphaApi.Result result = null;
            try { result = api.post("/eru/reconcile", new JSONObject().put("id", operation.id), token); }
            catch (Exception ignored) { }
            AlphaApi.Result response = result;
            runOnUiThread(() -> {
                if (isDestroyed() || screen != Screen.HOME || !token.equals(sessions.load()) ||
                        !operation.account.equals(activeAccountId)) return;
                EruOperationStore.Operation current = operations.load(
                        operation.account, operation.wallet, operation.cluster);
                if (current == null || !operation.id.equals(current.id)) return;
                String status = nextOperationStatus(current.status, response);
                if (!status.equals(current.status)) {
                    operations.save(new EruOperationStore.Operation(current.id, current.account,
                            current.wallet, current.cluster, status));
                    home();
                } else if ("pending".equals(current.status) || "unknown".equals(current.status)) {
                    scheduleOperationRefresh(current, 30_000);
                }
            });
        });
    }

    private GatewayMessagePolicy.Decoded verifyEruIntent(
            GatewayMessagePolicy policy, byte[] message) throws Exception {
        if (!"devnet".equals(policy.cluster())) return policy.validate(message);
        DevnetIntentClock clock = new DevnetIntentClock();
        GatewayMessagePolicy.Decoded decoded = policy.validate(message, clock.confirmedSlot());
        clock.requireFreshBlockhash(decoded.blockhash);
        return decoded;
    }

    private static String eru(long baseUnits) {
        return BigDecimal.valueOf(baseUnits, 9).stripTrailingZeros().toPlainString();
    }
}
