package xyz.etherings.player.alpha;

import android.content.Context;
import android.content.SharedPreferences;

final class AlphaWalletSelectionStore {
    private static final String NAME = "alpha-dev-wallet-selection-v1";
    private final SharedPreferences preferences;

    AlphaWalletSelectionStore(Context context) {
        preferences = context.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    boolean matches(String accountId, String address) {
        return accountId != null && address != null &&
                accountId.equals(preferences.getString("accountId", null)) &&
                address.equals(preferences.getString("address", null));
    }

    void save(String accountId, String address) {
        if (accountId == null || address == null || !preferences.edit()
                .putString("accountId", accountId).putString("address", address).commit())
            throw new IllegalStateException("Wallet selection could not be saved");
    }

    void clear() {
        if (!preferences.edit().clear().commit())
            throw new IllegalStateException("Wallet selection could not be cleared");
    }
}
