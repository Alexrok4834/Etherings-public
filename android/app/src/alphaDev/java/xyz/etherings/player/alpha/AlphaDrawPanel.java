package xyz.etherings.player.alpha;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.R;
import xyz.etherings.player.raffle.RafflePendingDrawEntity;
import xyz.etherings.player.raffle.RafflePendingDrawState;
import xyz.etherings.player.raffle.RafflePendingDrawStore;
import xyz.etherings.player.sync.EtheringsDatabase;

/** Alpha presentation over the existing durable Raffle v2 pending-draw store. */
public final class AlphaDrawPanel extends LinearLayout {
    private static final int GOLD = Color.rgb(224, 185, 93);
    private static final int DIM_GOLD = Color.rgb(126, 102, 57);
    private static final String[] TYPES = {"ERT", "ERU", "COPPER_RING", "SILVER_BOX"};
    private static final int[] ART = {R.drawable.raffle_reward_ert_10,
            R.drawable.raffle_reward_eru_5, R.drawable.raffle_reward_cooper_ring, 0};
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final RafflePendingDrawStore pending;
    private final Runnable onBalanceChanged;
    private final TextView status;
    private final TextView attempts;
    private final TextView action;
    private final ImageView center;
    private final LinearLayout[] slots = new LinearLayout[4];
    private final ImageView[] slotArt = new ImageView[4];
    private volatile JSONObject current;
    private Bitmap boxBitmap;
    private int displayedWinner = -1;
    private boolean busy;
    private int generation;

    public AlphaDrawPanel(Context context, Runnable onBalanceChanged) {
        super(context);
        if (onBalanceChanged == null) throw new IllegalArgumentException("balance callback required");
        this.onBalanceChanged = onBalanceChanged;
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER_HORIZONTAL);
        setBackgroundColor(Color.TRANSPARENT);
        setPadding(dp(12), dp(12), dp(12), dp(20));
        pending = new RafflePendingDrawStore(EtheringsDatabase.open(context));
        status = label("Loading Draw...", 15, DIM_GOLD);
        addView(status);
        center = new ImageView(context);
        center.setImageResource(R.drawable.etherings_logo_gold);
        center.setScaleType(ImageView.ScaleType.FIT_CENTER);
        int availableWidth = getResources().getDisplayMetrics().widthPixels - dp(56);
        LinearLayout.LayoutParams hero = new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, Math.max(dp(100), Math.min(dp(178), availableWidth / 2)));
        hero.topMargin = dp(18);
        hero.bottomMargin = dp(20);
        addView(center, hero);
        LinearLayout rewards = new LinearLayout(context);
        rewards.setOrientation(HORIZONTAL);
        for (int index = 0; index < 4; index++) {
            LinearLayout slot = new LinearLayout(context);
            slot.setOrientation(VERTICAL);
            slot.setGravity(Gravity.CENTER);
            slot.setPadding(dp(4), dp(8), dp(4), dp(7));
            slot.setBackground(border(DIM_GOLD, 1));
            ImageView art = new ImageView(context);
            art.setScaleType(ImageView.ScaleType.FIT_CENTER);
            if (ART[index] != 0) art.setImageResource(ART[index]);
            slot.addView(art, new LinearLayout.LayoutParams(
                    LayoutParams.MATCH_PARENT, dp(65)));
            TextView caption = label(index == 2 ? "Cooper Ring" :
                    index == 3 ? "Silver Box" : "--", 11, GOLD);
            slot.addView(caption);
            LinearLayout.LayoutParams item = new LinearLayout.LayoutParams(0, dp(112), 1f);
            if (index != 0) item.leftMargin = dp(4);
            rewards.addView(slot, item);
            slots[index] = slot;
            slotArt[index] = art;
        }
        addView(rewards, new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, dp(112)));
        attempts = label("", 14, DIM_GOLD);
        LinearLayout.LayoutParams info = new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, dp(46));
        info.topMargin = dp(14);
        addView(attempts, info);
        action = label("Loading...", 17, Color.BLACK);
        GradientDrawable actionBackground = border(GOLD, 2);
        actionBackground.setColor(GOLD);
        action.setBackground(actionBackground);
        action.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams button = new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, dp(52));
        addView(action, button);
        action.setOnClickListener(view -> onAction());
        load();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView label(String text, int sp, int color) {
        TextView view = new TextView(getContext());
        view.setText(text);
        view.setTextColor(color);
        view.setTextSize(sp);
        view.setGravity(Gravity.CENTER);
        view.setSingleLine(false);
        return view;
    }

    private GradientDrawable border(int color, int width) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(Color.TRANSPARENT);
        shape.setCornerRadius(dp(10));
        shape.setStroke(dp(width), color);
        return shape;
    }

    private AlphaSessionStore.VerifiedSession session() {
        return new AlphaSessionStore(getContext()).verified();
    }

    private boolean sameSession(AlphaSessionStore.VerifiedSession expected) {
        AlphaSessionStore.VerifiedSession live = session();
        return live != null && expected != null &&
                live.ownerId().equals(expected.ownerId()) &&
                live.lineage().equals(expected.lineage());
    }

    private void load() {
        AlphaSessionStore.VerifiedSession owner = session();
        if (owner == null) { status.setText("Sign in to Draw."); return; }
        int request = ++generation;
        busy = true;
        action.setEnabled(false);
        IO.execute(() -> {
            RafflePendingDrawEntity saved = pending.get(owner.ownerId());
            if (saved != null && saved.state == RafflePendingDrawState.SUBMITTING) {
                pending.recoverInterruptedSubmission(owner.ownerId(), saved.idempotencyKey,
                        System.currentTimeMillis());
                saved = pending.get(owner.ownerId());
            }
            if (saved != null && saved.state == RafflePendingDrawState.UNCERTAIN) {
                try { saved = submitSaved(owner, saved); }
                catch (Exception ignored) { /* same idempotency key remains recoverable */ }
            }
            JSONObject response = null;
            try {
                AlphaAuthApi.Result result = new AlphaAuthApi(getContext(), BuildConfig.ALPHA_DEV_API_BASE_URL)
                        .get("/raffle/v2/draw", owner.token());
                if (result.status == 200) {
                    validateCurrent(result.body);
                    response = result.body;
                }
            } catch (Exception ignored) { /* local result remains visible */ }
            RafflePendingDrawEntity finalSaved = saved;
            JSONObject finalResponse = response;
            handler.post(() -> {
                if (request != generation || !sameSession(owner)) return;
                busy = false;
                current = finalResponse;
                renderCurrent();
                renderSaved(owner, finalSaved, false);
                loadBox(finalResponse, finalSaved, request);
            });
        });
    }

    private void loadBox(JSONObject response, RafflePendingDrawEntity saved, int request) {
        JSONObject media = null;
        if (response != null) {
            JSONObject draw = response.optJSONObject("draw");
            JSONArray items = draw == null ? null : draw.optJSONArray("displayRewards");
            JSONObject box = items == null ? null : items.optJSONObject(3);
            media = box == null ? null : box.optJSONObject("media");
        }
        if (media == null && saved != null && saved.responseSnapshot != null) {
            try {
                JSONObject result = new JSONObject(saved.responseSnapshot);
                JSONObject reward = result.optJSONObject("reward");
                if (reward != null && "SILVER_BOX".equals(reward.optString("type")))
                    media = reward.optJSONObject("media");
            } catch (Exception ignored) { /* saved result is checked by renderSaved */ }
        }
        if (media == null) return;
        String uri = media.optString("uri");
        String hash = media.optString("contentHash");
        IO.execute(() -> {
            Bitmap bitmap = AlphaSilverArtwork.loadOne(getContext(), uri, hash);
            handler.post(() -> {
                if (request != generation || bitmap == null) return;
                boxBitmap = bitmap;
                slotArt[3].setImageBitmap(bitmap);
                if (displayedWinner == 3) center.setImageBitmap(bitmap);
            });
        });
    }

    private static void validateCurrent(JSONObject root) throws Exception {
        if (!"raffle-v2".equals(root.getString("contractVersion")))
            throw new IllegalStateException("Draw contract changed");
        JSONObject draw = root.getJSONObject("draw");
        UUID.fromString(draw.getString("configurationVersion"));
        JSONObject cost = draw.getJSONObject("cost");
        if (!"ERT".equals(cost.getString("currency")) ||
                !cost.getString("amountExact").matches("[0-9]+(?:\\.[0-9]+)?"))
            throw new IllegalStateException("Draw cost invalid");
        JSONObject attempts = draw.getJSONObject("attempts");
        int limit = attempts.getInt("limit");
        int used = attempts.getInt("used");
        int remaining = attempts.getInt("remaining");
        if (limit < 1 || used < 0 || remaining < 0 || used + remaining != limit)
            throw new IllegalStateException("Draw attempts invalid");
        JSONArray rewards = draw.getJSONArray("displayRewards");
        if (rewards.length() != 4) throw new IllegalStateException("Draw rewards invalid");
        for (int i = 0; i < 4; i++) {
            JSONObject item = rewards.getJSONObject(i);
            if (!TYPES[i].equals(item.getString("type")))
                throw new IllegalStateException("Draw reward order invalid");
            UUID.fromString(item.getString("rewardId"));
        }
    }

    private static int winner(JSONObject response) throws Exception {
        if (!"raffle-v2".equals(response.getString("contractVersion")))
            throw new IllegalStateException("Draw result contract invalid");
        JSONObject result = response.getJSONObject("draw");
        UUID.fromString(result.getString("drawResultId"));
        JSONObject reward = response.getJSONObject("reward");
        JSONObject selection = response.getJSONObject("selection");
        if (!"CSPRNG_UNBIASED_INT_V1".equals(selection.getString("algorithm")) ||
                !"COMPLETED".equals(response.getJSONObject("operation").getString("status")))
            throw new IllegalStateException("Draw result status invalid");
        long ticket = Long.parseLong(selection.getString("ticket"));
        long total = Long.parseLong(selection.getString("totalWeight"));
        JSONArray ranges = selection.getJSONArray("ranges");
        if (ticket < 0 || total < 1 || ticket >= total ||
                ranges.length() < 1 || ranges.length() > 4)
            throw new IllegalStateException("Draw selection invalid");
        long cursor = 0;
        String selected = null;
        int selectedIndex = -1;
        for (int i = 0; i < ranges.length(); i++) {
            JSONObject range = ranges.getJSONObject(i);
            long start = Long.parseLong(range.getString("startInclusive"));
            long end = Long.parseLong(range.getString("endExclusive"));
            if (start != cursor || end <= start || end > total ||
                    range.getInt("segmentIndex") != i)
                throw new IllegalStateException("Draw ranges invalid");
            if (start <= ticket && ticket < end) {
                selected = range.getString("rewardId");
                selectedIndex = i;
            }
            cursor = end;
        }
        if (cursor != total || !reward.getString("rewardId").equals(selected) ||
                selection.getInt("selectedSegmentIndex") != selectedIndex ||
                reward.getInt("segmentIndex") != selectedIndex)
            throw new IllegalStateException("Draw selected reward invalid");
        String type = reward.getString("type");
        String settlement = response.getJSONObject("fulfillment").getString("type");
        String[] expected = {"ERT_CREDIT", "ERU_PAYOUT", "RING_AWARD",
                "SILVER_BOX_ISSUANCE"};
        for (int i = 0; i < TYPES.length; i++) if (TYPES[i].equals(type) &&
                expected[i].equals(settlement)) return i;
        throw new IllegalStateException("Unknown Draw reward");
    }

    private RafflePendingDrawEntity submitSaved(AlphaSessionStore.VerifiedSession owner,
            RafflePendingDrawEntity saved) throws Exception {
        JSONObject request = new JSONObject().put("contractVersion", "raffle-v2")
                .put("configurationVersion", saved.configurationVersion)
                .put("idempotencyKey", saved.idempotencyKey);
        AlphaAuthApi.Result response = new AlphaAuthApi(getContext(), BuildConfig.ALPHA_DEV_API_BASE_URL)
                .post("/raffle/v2/draw", request, owner.token());
        if (response.status == 200) {
            JSONObject operation = response.body.getJSONObject("operation");
            if (!saved.idempotencyKey.equals(operation.getString("idempotencyKey")) ||
                    !saved.configurationVersion.equals(response.body.getJSONObject("draw")
                            .getString("configurationVersion")))
                throw new IllegalStateException("Draw replay identity mismatch");
            winner(response.body);
            pending.storeCompleted(owner.ownerId(), saved.idempotencyKey,
                    response.body.toString(), System.currentTimeMillis());
            return pending.get(owner.ownerId());
        }
        if ((response.status == 409 || response.status == 400) &&
                response.body.optString("code").matches(
                "(?:DRAW_(?:UNAVAILABLE|CONFIGURATION_STALE|DAILY_LIMIT|IDEMPOTENCY_CONFLICT)|" +
                "INSUFFICIENT_ERT|INVALID_DRAW_REQUEST)")) {
            pending.markTerminalRejected(owner.ownerId(), saved.idempotencyKey,
                    response.body.getString("code"), System.currentTimeMillis());
            return pending.get(owner.ownerId());
        }
        throw new IllegalStateException("Draw response uncertain");
    }

    private void renderCurrent() {
        if (current == null) {
            status.setText("Draw is temporarily unavailable.");
            attempts.setText("");
            action.setText("Retry");
            action.setEnabled(true);
            return;
        }
        JSONObject draw = current.optJSONObject("draw");
        JSONObject cost = draw == null ? null : draw.optJSONObject("cost");
        JSONObject count = draw == null ? null : draw.optJSONObject("attempts");
        String amount = cost == null ? "--" : cost.optString("amountDisplay", "--");
        status.setText("One Draw · " + amount + " ERT");
        attempts.setText(count == null ? "" : "Today: " + count.optInt("remaining") +
                " of " + count.optInt("limit") + " left");
        action.setText("Draw · " + amount + " ERT");
        action.setEnabled(!busy && count != null && count.optInt("remaining") > 0);
        JSONArray display = draw == null ? null : draw.optJSONArray("displayRewards");
        if (display != null) for (int i = 0; i < 4; i++) {
            JSONObject reward = display.optJSONObject(i);
            if (reward != null && !reward.optBoolean("eligible", true)) slots[i].setAlpha(0.5f);
            else slots[i].setAlpha(1f);
            if (i < 2 && reward != null) {
                TextView caption = (TextView) slots[i].getChildAt(1);
                caption.setText(reward.optString("title", TYPES[i]));
            }
        }
    }

    private void renderSaved(AlphaSessionStore.VerifiedSession owner,
            RafflePendingDrawEntity saved, boolean animate) {
        if (saved == null) return;
        if (saved.state == RafflePendingDrawState.UNCERTAIN ||
                saved.state == RafflePendingDrawState.SUBMITTING) {
            status.setText("Draw status uncertain; retry the same operation.");
            action.setText("Recover Draw");
            action.setEnabled(true);
            return;
        }
        if (saved.state == RafflePendingDrawState.TERMINAL_REJECTED) {
            status.setText("Draw unavailable: " + saved.terminalErrorCode);
            action.setText("Continue");
            action.setEnabled(true);
            return;
        }
        try {
            JSONObject result = new JSONObject(saved.responseSnapshot);
            int chosen = winner(result);
            action.setEnabled(false);
            if (animate && saved.state == RafflePendingDrawState.COMPLETED_UNREVEALED) {
                animate(owner, saved, result, chosen);
            } else {
                showWinner(result, chosen);
                if (saved.state == RafflePendingDrawState.COMPLETED_UNREVEALED)
                    IO.execute(() -> pending.markRevealed(owner.ownerId(),
                            saved.idempotencyKey, System.currentTimeMillis()));
            }
        } catch (Exception error) {
            status.setText("Saved Draw result could not be displayed.");
        }
    }

    private void animate(AlphaSessionStore.VerifiedSession owner,
            RafflePendingDrawEntity saved, JSONObject result, int chosen) {
        final int request = generation;
        // Five complete, fixed-order tours; only the persisted result picks stop.
        final int steps = 20 + chosen;
        for (int step = 0; step <= steps; step++) {
            final int currentStep = step;
            handler.postDelayed(() -> {
                if (request != generation || !sameSession(owner)) return;
                highlight(currentStep % 4);
                if (currentStep == steps) {
                    showWinner(result, chosen);
                    IO.execute(() -> pending.markRevealed(owner.ownerId(),
                            saved.idempotencyKey, System.currentTimeMillis()));
                }
            }, step * 90L);
        }
    }

    private void highlight(int index) {
        for (int i = 0; i < slots.length; i++)
            slots[i].setBackground(border(i == index ? GOLD : DIM_GOLD,
                    i == index ? 3 : 1));
    }

    private void showWinner(JSONObject result, int chosen) {
        displayedWinner = chosen;
        highlight(chosen);
        if (chosen == 3 && boxBitmap != null) center.setImageBitmap(boxBitmap);
        else if (ART[chosen] != 0) center.setImageResource(ART[chosen]);
        else center.setImageResource(R.drawable.etherings_logo_gold);
        JSONObject reward = result.optJSONObject("reward");
        JSONObject fulfillment = result.optJSONObject("fulfillment");
        status.setText("Won: " + (reward == null ? TYPES[chosen] :
                reward.optString("title", TYPES[chosen])) +
                (fulfillment != null && !"CONFIRMED".equals(
                        fulfillment.optString("state")) ? " · delivery pending" : ""));
        JSONObject draw = current == null ? null : current.optJSONObject("draw");
        JSONObject count = draw == null ? null : draw.optJSONObject("attempts");
        boolean available = count != null && count.optInt("remaining") > 0;
        action.setText(available ? "Draw again" : "Daily limit reached");
        action.setEnabled(available);
    }

    private void onAction() {
        if (busy) return;
        if (current == null) { load(); return; }
        AlphaSessionStore.VerifiedSession owner = session();
        if (owner == null) return;
        int request = ++generation;
        busy = true;
        action.setEnabled(false);
        IO.execute(() -> {
            try {
                RafflePendingDrawEntity saved = pending.get(owner.ownerId());
                if (saved != null && saved.state == RafflePendingDrawState.TERMINAL_REJECTED) {
                    pending.clearTerminal(owner.ownerId(), saved.idempotencyKey);
                    handler.post(() -> {
                        if (request != generation || !sameSession(owner)) return;
                        busy = false;
                        renderCurrent();
                    });
                    return;
                }
                if (saved != null && saved.state == RafflePendingDrawState.COMPLETED_UNREVEALED) {
                    pending.markRevealed(owner.ownerId(), saved.idempotencyKey,
                            System.currentTimeMillis());
                    RafflePendingDrawEntity completed = pending.get(owner.ownerId());
                    handler.post(() -> {
                        if (request != generation || !sameSession(owner)) return;
                        busy = false;
                        renderSaved(owner, completed, false);
                    });
                    return;
                }
                if (saved != null && saved.state == RafflePendingDrawState.REVEALED) {
                    pending.clearTerminal(owner.ownerId(), saved.idempotencyKey);
                    saved = null;
                }
                if (saved == null) {
                    if (current == null) throw new IllegalStateException("Draw configuration unavailable");
                    String version = current.getJSONObject("draw").getString("configurationVersion");
                    pending.createSubmitting(owner.ownerId(), version,
                            UUID.randomUUID().toString(), System.currentTimeMillis());
                    saved = pending.get(owner.ownerId());
                }
                RafflePendingDrawEntity result;
                try { result = submitSaved(owner, saved); }
                catch (Exception error) {
                    if (saved.state == RafflePendingDrawState.SUBMITTING)
                        pending.recoverInterruptedSubmission(owner.ownerId(),
                                saved.idempotencyKey, System.currentTimeMillis());
                    throw error;
                }
                JSONObject refreshed = null;
                try {
                    AlphaAuthApi.Result latest = new AlphaAuthApi(getContext(), BuildConfig.ALPHA_DEV_API_BASE_URL)
                            .get("/raffle/v2/draw", owner.token());
                    if (latest.status == 200) {
                        validateCurrent(latest.body);
                        refreshed = latest.body;
                    }
                } catch (Exception ignored) { /* committed result still wins */ }
                JSONObject finalRefreshed = refreshed;
                handler.post(() -> {
                    if (request != generation || !sameSession(owner)) return;
                    busy = false;
                    if (finalRefreshed != null) {
                        current = finalRefreshed;
                        renderCurrent();
                    }
                    renderSaved(owner, result, true);
                    if (result != null && (result.state == RafflePendingDrawState.COMPLETED_UNREVEALED
                            || result.state == RafflePendingDrawState.REVEALED)) onBalanceChanged.run();
                });
            } catch (Exception error) {
                handler.post(() -> {
                    if (request != generation || !sameSession(owner)) return;
                    busy = false;
                    status.setText("Draw status uncertain. Retry the same operation.");
                    action.setText("Recover Draw");
                    action.setEnabled(true);
                });
            }
        });
    }

    public static void showHistory(Context context) {
        AlphaSessionStore.VerifiedSession owner = new AlphaSessionStore(context).verified();
        if (owner == null) return;
        IO.execute(() -> {
            String message;
            try {
                AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                        .get("/raffle/v2/history", owner.token());
                if (result.status != 200) throw new IllegalStateException();
                JSONArray items = result.body.getJSONArray("items");
                StringBuilder rows = new StringBuilder();
                for (int i = 0; i < Math.min(items.length(), 20); i++) {
                    JSONObject item = items.getJSONObject(i);
                    int chosen = winner(item);
                    JSONObject draw = item.getJSONObject("draw");
                    JSONObject fulfillment = item.getJSONObject("fulfillment");
                    rows.append(draw.optString("createdAt", "")).append("  ·  ")
                            .append(item.getJSONObject("reward").optString("title", TYPES[chosen]))
                            .append("  ·  ").append(fulfillment.optString("state", ""))
                            .append('\n');
                }
                message = rows.length() == 0 ? "No Draws yet." : rows.toString();
            } catch (Exception error) { message = "Draw history is unavailable."; }
            String shown = message;
            new Handler(Looper.getMainLooper()).post(() -> {
                AlphaSessionStore.VerifiedSession live = new AlphaSessionStore(context).verified();
                if (live == null || !live.ownerId().equals(owner.ownerId()) ||
                        !live.lineage().equals(owner.lineage()) || !(context instanceof Activity)) return;
                new AlertDialog.Builder(context).setTitle("Draw history")
                        .setMessage(shown).setPositiveButton("Close", null).show();
            });
        });
    }
}
