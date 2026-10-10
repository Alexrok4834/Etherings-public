package xyz.etherings.player.alpha;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.R;
import xyz.etherings.player.MainActivity;
import xyz.etherings.player.step.StepForegroundService;
import xyz.etherings.player.auth.RoomInstallationIdProvider;
import xyz.etherings.player.update.AppUpdateNotice;

public final class AlphaAuthActivity extends Activity {
    private enum Screen { REGISTER, VERIFY, LOGIN, HOME }
    static final String SHOW_LOGIN = "xyz.etherings.player.alpha.SHOW_LOGIN";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private AlphaAuthApi api;
    private AlphaSessionStore sessions;
    private LinearLayout content;
    private TextView feedback;
    private Screen screen = Screen.REGISTER;
    private String email = "";
    private String installationId;
    private AppUpdateNotice updateNotice;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if ("alphaRelease".equals(BuildConfig.BUILD_TYPE))
            updateNotice = new AppUpdateNotice(this);
        sessions = new AlphaSessionStore(this);
        try { api = new AlphaAuthApi(this, BuildConfig.ALPHA_DEV_API_BASE_URL); }
        catch (IllegalArgumentException ignored) { shell("Connection unavailable"); return; }
        if (getIntent().getBooleanExtra(SHOW_LOGIN, false)) {
            login();
            return;
        }
        String saved = sessions.load();
        if (saved == null) register();
        else { shell("Signing you in..."); checkSession(saved); }
    }

    @Override protected void onStart() {
        super.onStart();
        if (updateNotice != null) updateNotice.onStart();
    }

    @Override protected void onStop() {
        if (updateNotice != null) updateNotice.onStop();
        super.onStop();
    }

    @Override protected void onDestroy() {
        io.shutdownNow();
        super.onDestroy();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void shell(String title) {
        AlphaUi.window(this);
        LinearLayout root = AlphaUi.column(this);
        root.setPadding(dp(20), dp(28), dp(20), dp(24));
        root.addView(AlphaUi.logo(this, 82));
        TextView brand = AlphaUi.text(this, "EtheRings", 17, R.color.brand_accent);
        brand.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams brandParams = new LinearLayout.LayoutParams(-1, dp(34));
        brandParams.bottomMargin = dp(26);
        root.addView(brand, brandParams);
        content = AlphaUi.column(this);
        content.setPadding(dp(20), dp(22), dp(20), dp(18));
        content.setBackground(AlphaUi.shape(this, R.color.brand_surface, true));
        root.addView(content, new LinearLayout.LayoutParams(-1, -2));
        setContentView(AlphaUi.scroll(this, root));
        TextView heading = AlphaUi.text(this, title, 21, R.color.brand_text_primary);
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(-1, -2);
        headingParams.bottomMargin = dp(16);
        content.addView(heading, headingParams);
        feedback = AlphaUi.text(this, "", 14, R.color.brand_error);
        feedback.setMinHeight(dp(34));
        content.addView(feedback);
    }

    private EditText field(String hint, int type) {
        EditText edit = AlphaUi.field(this, hint, type);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(56));
        params.bottomMargin = dp(12);
        content.addView(edit, params);
        return edit;
    }

    private Button button(String label) {
        Button button = AlphaUi.button(this, label, true);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(48));
        params.topMargin = dp(8);
        params.bottomMargin = dp(8);
        content.addView(button, params);
        return button;
    }

    private TextView link(String label) {
        TextView action = AlphaUi.link(this, label);
        content.addView(action, new LinearLayout.LayoutParams(-1, dp(44)));
        return action;
    }

    private JSONObject body(String key1, String value1, String key2, String value2) throws Exception {
        JSONObject json = new JSONObject();
        json.put(key1, value1);
        if (key2 != null) json.put(key2, value2);
        return json;
    }

    private interface Handler { void accept(AlphaAuthApi.Result result) throws Exception; }

    private void submit(Button command, Callable<AlphaAuthApi.Result> request, Handler handler) {
        Screen origin = screen;
        command.setEnabled(false);
        String original = command.getText().toString();
        command.setText("Please wait...");
        feedback.setText("");
        io.execute(() -> {
            try {
                AlphaAuthApi.Result result = request.call();
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || screen != origin) return;
                    command.setEnabled(true);
                    command.setText(original);
                    try { handler.accept(result); }
                    catch (Exception ignored) { feedback.setText("Request could not be completed."); }
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || screen != origin) return;
                    command.setEnabled(true);
                    command.setText(original);
                    feedback.setText("Connection unavailable. Try again.");
                });
            }
        });
    }

    private void error(int status) {
        feedback.setTextColor(getColor(R.color.brand_error));
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
        password.setImeOptions(EditorInfo.IME_ACTION_DONE);
        Button action = button("Create account");
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
        link("I have a code").setOnClickListener(view -> { email = address.getText().toString().trim(); verify(); });
        link("Already have an account? Log in").setOnClickListener(view -> { email = address.getText().toString().trim(); login(); });
    }

    private void verify() {
        screen = Screen.VERIFY;
        shell("Verify email");
        EditText address = field("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        address.setText(email);
        EditText code = field("4-digit code", InputType.TYPE_CLASS_NUMBER);
        code.setFilters(new InputFilter[] { new InputFilter.LengthFilter(4) });
        code.setTextSize(24);
        code.setGravity(Gravity.CENTER);
        code.setImeOptions(EditorInfo.IME_ACTION_DONE);
        Button action = button("Confirm email");
        action.setOnClickListener(view -> {
            String inputEmail = address.getText().toString().trim();
            String inputCode = code.getText().toString().trim();
            if (!inputCode.matches("[0-9]{4}")) { feedback.setText("Enter the 4-digit code."); return; }
            submit(action, () -> {
                installationId = new RoomInstallationIdProvider(this).installationId();
                return api.post("/auth/verify", body("email", inputEmail, "code", inputCode)
                        .put("installationId", installationId), null);
            }, result -> {
                code.setText("");
                if (result.status == 200) { email = inputEmail; acceptSession(result.body); }
                else error(result.status);
            });
        });
        TextView resend = link("Send a new code");
        resend.setOnClickListener(view -> {
            String inputEmail = address.getText().toString().trim();
            resend.setEnabled(false);
            feedback.setTextColor(getColor(R.color.brand_text_secondary));
            feedback.setText("Sending...");
            io.execute(() -> {
                int status;
                try { status = api.post("/auth/resend", body("email", inputEmail, null, null), null).status; }
                catch (Exception ignored) { status = 503; }
                int result = status;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || screen != Screen.VERIFY) return;
                    resend.setEnabled(true);
                    if (result == 202) {
                        feedback.setTextColor(getColor(R.color.brand_success));
                        feedback.setText("If eligible, a new code has been sent.");
                    } else error(result);
                });
            });
        });
        link("Back to log in").setOnClickListener(view -> login());
    }

    private void login() {
        screen = Screen.LOGIN;
        shell("Log in");
        EditText address = field("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        address.setText(email);
        EditText password = field("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setImeOptions(EditorInfo.IME_ACTION_DONE);
        Button action = button("Log in");
        action.setOnClickListener(view -> {
            String inputEmail = address.getText().toString().trim();
            String inputPassword = password.getText().toString();
            submit(action, () -> {
                installationId = new RoomInstallationIdProvider(this).installationId();
                return api.post("/auth/login", body("email", inputEmail, "password", inputPassword)
                        .put("installationId", installationId), null);
            }, result -> {
                password.setText("");
                if (result.status == 200) { email = inputEmail; acceptSession(result.body); }
                else error(result.status);
            });
        });
        link("Create an account").setOnClickListener(view -> register());
        link("Enter a verification code").setOnClickListener(view -> { email = address.getText().toString().trim(); verify(); });
    }

    private void acceptSession(JSONObject enrollment) {
        stopService(StepForegroundService.stopIntent(this));
        try {
            String token = enrollment.getString("accessToken");
            sessions.save(token);
            shell("Checking account...");
            checkSession(token, enrollment);
        }
        catch (Exception ignored) { sessions.clear(); shell("Sign-in unavailable"); button("Log in").setOnClickListener(view -> login()); }
    }

    private void checkSession(String token) {
        checkSession(token, null);
    }

    private void checkSession(String token, JSONObject enrollment) {
        io.execute(() -> {
            try {
                AlphaSessionIdentity expected = sessions.current();
                AlphaAuthApi.Result result = api.get("/auth/me", token);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    if (result.status == 200) {
                        try {
                            String accountId = result.body.optString("id", "");
                            AlphaSessionIdentity current = sessions.current();
                            if (current == null || expected == null ||
                                    (expected.accountId == null ?
                                            !expected.token.equals(current.token) :
                                            !expected.lineage.equals(current.lineage)))
                                throw new IllegalStateException();
                            if (enrollment != null) sessions.saveVerified(token, accountId,
                                    enrollment.getString("refreshToken"),
                                    enrollment.getString("refreshTokenExpiresAt"), installationId);
                            else if (current.accountId == null) sessions.saveVerified(token, accountId);
                            else if (!current.accountId.equals(accountId)) throw new IllegalStateException();
                            home(result.body.optString("email", ""));
                        } catch (Exception ignored) { retrySession(token); }
                    }
                    else if (result.status == 401) {
                        sessions.clearIfCurrent(expected);
                        stopService(StepForegroundService.stopIntent(this));
                        login();
                    }
                    else retrySession(token);
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) retrySession(token); });
            }
        });
    }

    private void retrySession(String token) {
        shell("Connection unavailable");
        button("Try again").setOnClickListener(view -> { shell("Signing you in..."); checkSession(token); });
    }

    private void home(String verifiedEmail) {
        screen = Screen.HOME;
        AlphaLaunchGate.grant(verifiedEmail);
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra(MainActivity.ALPHA_VERIFIED_EMAIL, verifiedEmail);
        startActivity(intent);
        finish();
    }
}
