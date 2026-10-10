package xyz.etherings.alpha;

import android.app.Activity;
import android.app.AlertDialog;

import org.json.JSONObject;

import java.util.Arrays;

final class SilverOpeningApprovalDialog {
    interface Result { void finished(boolean signed); }
    interface ApprovalGuard { void requireCurrent() throws Exception; }

    static void show(Activity activity, JSONObject candidate, SilverOpeningPolicy policy,
            SilverOpeningChainClock clock, AlphaWallet wallet, String boundAddress,
            ApprovalGuard guard, Result result) throws Exception {
        JSONObject exact = new JSONObject(candidate.toString());
        SilverOpeningPolicy.Decoded decoded = policy.validateResponse(exact);
        if (!boundAddress.equals(decoded.authority) || !boundAddress.equals(wallet.address()))
            throw new IllegalArgumentException("Silver opening wallet changed");
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("Confirm Silver Box opening")
                .setMessage("1 Silver Box\nMint: " + decoded.mint +
                        "\nEscrow: " + decoded.escrow +
                        "\nRequest: " + decoded.request +
                        "\nNetwork fee: test SOL")
                .setNegativeButton("Cancel", (ignored, which) -> result.finished(false))
                .setPositiveButton("Sign opening", null)
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(view -> {
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
                    new Thread(() -> {
                        boolean signed = false;
                        try {
                            guard.requireCurrent();
                            SilverOpeningPolicy.Decoded checked = policy.validateResponse(exact);
                            if (!boundAddress.equals(wallet.address()))
                                throw new IllegalArgumentException("Silver opening wallet changed");
                            clock.requireCurrent(policy, checked,
                                    exact.getLong("lastValidBlockHeight"));
                            byte[] signature = wallet.signSilverOpening(exact, policy,
                                    boundAddress);
                            try { signed = signature.length == 64; }
                            finally { Arrays.fill(signature, (byte) 0); }
                        } catch (Exception ignoredError) { signed = false; }
                        boolean outcome = signed;
                        activity.runOnUiThread(() -> {
                            dialog.dismiss();
                            result.finished(outcome);
                        });
                    }, "silver-opening-confirm").start();
                }));
        dialog.show();
    }
}
