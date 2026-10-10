package xyz.etherings.alpha;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

final class EruOperationStore {
    private final SharedPreferences prefs;

    EruOperationStore(Context context) {
        this(context, "alpha-eru-operation-v1");
    }

    EruOperationStore(Context context, String name) {
        prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE);
    }

    static final class Operation {
        final String id, account, wallet, cluster, status;

        Operation(String id, String account, String wallet, String cluster, String status) {
            this.id = id;
            this.account = account;
            this.wallet = wallet;
            this.cluster = cluster;
            this.status = status;
        }
    }

    Operation load(String account, String wallet, String cluster) {
        String key = account + ":" + cluster + ":";
        String id = prefs.getString(key + "id", "");
        if (!validId(id) || !wallet.equals(prefs.getString(key + "wallet", ""))) return null;
        String status = prefs.getString(key + "status", "");
        return validStatus(status) ? new Operation(id, account, wallet, cluster, status) : null;
    }

    void save(Operation operation) {
        if (!validId(operation.id) || !validStatus(operation.status) ||
                operation.account.isEmpty() || operation.wallet.isEmpty() || operation.cluster.isEmpty())
            throw new IllegalArgumentException("Invalid ERU operation");
        String key = operation.account + ":" + operation.cluster + ":";
        if (!prefs.edit().putString(key + "id", operation.id)
                .putString(key + "wallet", operation.wallet)
                .putString(key + "status", operation.status).commit())
            throw new IllegalStateException("ERU operation persistence failed");
    }

    static boolean validStatus(String status) {
        return "pending".equals(status) || "unknown".equals(status) ||
                "confirmed".equals(status) || "failed".equals(status);
    }

    private static boolean validId(String id) {
        try { return UUID.fromString(id).toString().equals(id); }
        catch (Exception ignored) { return false; }
    }
}
