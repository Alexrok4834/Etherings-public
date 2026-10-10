package xyz.etherings.player.alpha.wallet;

import java.time.Instant;
import java.util.UUID;

public final class WalletOperation {
    public final String id;
    public final String nonce;
    public final String type;
    public final String direction;
    public final String amount;
    public final String fee;
    public final String counterparty;
    public final String status;
    public final String transactionSignature;
    public final Instant createdAt;

    private WalletOperation(String id, String nonce, String type, String direction,
            String amount, String fee, String counterparty, String status,
            String transactionSignature, Instant createdAt) {
        this.id = id;
        this.nonce = nonce;
        this.type = type;
        this.direction = direction;
        this.amount = amount;
        this.fee = fee;
        this.counterparty = counterparty;
        this.status = status;
        this.transactionSignature = transactionSignature;
        this.createdAt = createdAt;
    }

    public static WalletOperation from(String id, String nonce, String type, String direction,
            String amount, String fee, String counterparty, String status,
            String transactionSignature, String createdAt) {
        if (id == null || !id.equals(UUID.fromString(id).toString()) ||
                (nonce != null && !nonce.matches("[1-9][0-9]*")) ||
                !("send".equals(type) || "legacy_send".equals(type) ||
                  "cooper_level_up".equals(type) || "silver_level_up".equals(type) ||
                  "breeding".equals(type) || "draw_reward".equals(type)) ||
                !("in".equals(direction) || "out".equals(direction)) ||
                (!"legacy_send".equals(type) &&
                  (amount == null || !amount.matches("(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,18})?"))) ||
                (fee != null && !fee.matches("(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,18})?")) ||
                (counterparty != null &&
                  !counterparty.matches("[1-9A-HJ-NP-Za-km-z]{32,44}")) ||
                ("send".equals(type) && (nonce == null || counterparty == null ||
                  ("out".equals(direction) && fee == null))) ||
                ("draw_reward".equals(type) && !"in".equals(direction)) ||
                (("cooper_level_up".equals(type) || "silver_level_up".equals(type) ||
                  "breeding".equals(type)) && !"out".equals(direction)) ||
                !("pending".equals(status) || "confirmed".equals(status) ||
                  "failed".equals(status) || "unknown".equals(status)) ||
                (transactionSignature != null &&
                  !transactionSignature.matches("[1-9A-HJ-NP-Za-km-z]{80,90}"))) {
            throw new IllegalArgumentException("Invalid wallet operation");
        }
        return new WalletOperation(id, nonce, type, direction, amount, fee, counterparty,
                status, transactionSignature,
                Instant.parse(createdAt));
    }

    public String shortSignature() {
        if (transactionSignature == null) return null;
        return transactionSignature.substring(0, 8) + "..." +
                transactionSignature.substring(transactionSignature.length() - 8);
    }

    public String displayStatus(String locallySignedIntentId) {
        return id.equals(locallySignedIntentId) &&
                (status.equals("pending") || status.equals("unknown")) ? "unknown" : status;
    }
}
