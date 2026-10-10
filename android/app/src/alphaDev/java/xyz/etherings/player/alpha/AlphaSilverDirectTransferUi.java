package xyz.etherings.player.alpha;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputType;
import android.widget.EditText;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

/** Selected owned Ring/SEALED Box Send in the existing detail flow. */
public final class AlphaSilverDirectTransferUi {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private AlphaSilverDirectTransferUi() { }

    public static void show(Activity activity, String mint, String kind, Runnable afterFinality) {
        IO.execute(() -> {
            try {
                JSONObject pending = AlphaSilverDirectTransferClient.pending(activity);
                if (pending != null) {
                    checkPending(activity, pending, afterFinality);
                    return;
                }
                activity.runOnUiThread(() -> recipientDialog(activity, mint, kind, afterFinality));
            } catch (Exception error) { problem(activity, error.getMessage()); }
        });
    }

    private static void recipientDialog(Activity activity, String mint, String kind,
            Runnable afterFinality) {
        EditText input = new EditText(activity);
        input.setHint("Recipient Solana wallet address");
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(activity).setTitle("Send " + kind.replace('_', ' '))
                .setMessage("Owner-signed NFT transfer. The recipient's Token-2022 ATA " +
                        "will be created if absent; you pay only Devnet network/rent costs. " +
                        "Direct transfer resets the 48-hour on-chain cooldown.")
                .setView(input).setNegativeButton("Back", null)
                .setPositiveButton("Review", (dialog, which) -> {
                    String recipient = input.getText().toString().trim();
                    try { AssociatedTokenAddress.decode(recipient); }
                    catch (Exception error) { problem(activity, "Invalid recipient wallet"); return; }
                    IO.execute(() -> {
                        try {
                            String operationId = UUID.randomUUID().toString();
                            JSONObject approved = AlphaSilverDirectTransferClient.review(
                                    activity, mint, recipient, operationId);
                            JSONObject terms = approved.getJSONObject("terms");
                            if (!kind.equals(terms.getString("kind")))
                                throw new IllegalStateException("NFT kind changed");
                            activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                                    .setTitle("Review Silver Send")
                                    .setMessage("Mint: " + mint + "\nRecipient: " + recipient +
                                            "\nAmount: 1 NFT\nNetwork/rent paid by your wallet" +
                                            (terms.optBoolean("createsRecipientAta") ?
                                                    "\nRecipient ATA: create if absent" : "") +
                                            "\n48-hour direct-transfer cooldown resets. " +
                                            "An ACTIVE listing, if any, becomes stale; " +
                                            "this does not auto-UNLIST it.")
                                    .setNegativeButton("Back", null)
                                    .setPositiveButton("Refresh and sign", (d, w) ->
                                            submit(activity, approved, mint, recipient,
                                                    operationId, afterFinality))
                                    .show());
                        } catch (Exception error) { problem(activity, error.getMessage()); }
                    });
                }).show();
    }

    private static void submit(Activity activity, JSONObject approved, String mint,
            String recipient, String operationId, Runnable afterFinality) {
        IO.execute(() -> {
            try {
                JSONObject refreshed = AlphaSilverDirectTransferClient.refresh(activity, approved);
                byte[] signature = AlphaSilverDirectTransferClient.signReviewed(activity,
                        approved, refreshed, mint, recipient);
                AlphaSilverDirectTransferClient.submit(activity, refreshed, signature);
                checkPending(activity, new JSONObject().put("operationId", operationId),
                        afterFinality);
            } catch (Exception error) {
                problem(activity, "Submission not confirmed. Check Send status before retrying. " +
                        error.getMessage());
            }
        });
    }

    private static void checkPending(Activity activity, JSONObject pending,
            Runnable afterFinality) {
        IO.execute(() -> {
            try {
                String operationId = pending.getString("operationId");
                JSONObject status = null;
                for (int attempt = 0; attempt < 20; attempt++) {
                    status = AlphaSilverDirectTransferClient.status(activity, operationId);
                    if ("not_submitted".equals(status.optString("status")) &&
                            pending.has("refreshed") &&
                            pending.has("userSignatureBase64")) {
                        try { AlphaSilverDirectTransferClient.retryExactPending(activity, pending); }
                        catch (Exception ignored) { /* Keep exact signed intent for later retry. */ }
                        status = AlphaSilverDirectTransferClient.status(activity, operationId);
                    }
                    if (!"unknown".equals(status.optString("status"))) break;
                    Thread.sleep(1000);
                }
                String outcome = status == null ? "unknown" : status.optString("status", "unknown");
                if ("confirmed".equals(outcome) || "failed".equals(outcome)) {
                    AlphaSilverDirectTransferClient.clearPending(activity);
                    if ("confirmed".equals(outcome)) activity.runOnUiThread(afterFinality);
                }
                activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                        .setTitle("Silver Send: " + outcome)
                        .setMessage("unknown".equals(outcome) || "not_submitted".equals(outcome) ?
                                "Finalized status is not available yet. Do not sign another " +
                                        "transfer; open SEND again to retry/check this exact operation." :
                                "Finalized chain status: " + outcome +
                                        ("confirmed".equals(outcome) ?
                                                ". Inventory and Equip are refreshing." : "."))
                        .setPositiveButton("OK", null).show());
            } catch (Exception error) { problem(activity, error.getMessage()); }
        });
    }

    private static void problem(Activity activity, String message) {
        activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                .setTitle("Silver Send unavailable")
                .setMessage(message == null ? "Check the current status before retrying." : message)
                .setPositiveButton("OK", null).show());
    }
}
