package xyz.etherings.player.alpha;

import android.content.Context;

import java.time.LocalDate;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.wallet.AlphaWallet;
import xyz.etherings.player.alpha.wallet.WalletAssetSnapshot;
import xyz.etherings.player.home.AlphaHomeEconomySnapshot;

public final class AlphaHomeEconomyClient {
    private AlphaHomeEconomyClient() { }

    public static AlphaHomeEconomySnapshot load(Context context) throws Exception {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        AlphaSessionStore.VerifiedSession session = sessions.verified();
        if (session == null) throw new IllegalStateException("Verified Alpha session required");
        String date = LocalDate.now().toString();
        AlphaAuthApi api = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL);
        AlphaAuthApi.Result profile = api.get("/m2e/today?date=" + date, session.token());
        if (profile.status != 200) throw new IllegalStateException("Alpha economy unavailable");
        AlphaHomeEconomySnapshot snapshot = AlphaHomeEconomySnapshot.from(
                profile.body, session.ownerId(), date);
        try {
            AlphaWallet wallet = new AlphaWallet(context);
            if (wallet.exists()) {
                AlphaAuthApi.Result assets = api.get("/wallet/assets", session.token());
                if (assets.status == 200) {
                    WalletAssetSnapshot verified = WalletAssetSnapshot.from(
                            assets.body.getString("cluster"), assets.body.getString("walletAddress"),
                            wallet.address(), assets.body.getString("eruMint"),
                            AlphaWalletActivity.CANONICAL_ERU_MINT,
                            assets.body.getString("solLamports"),
                            assets.body.getString("eruBaseUnits"));
                    snapshot = snapshot.withWalletEru(verified.eru);
                }
            }
        } catch (Exception ignored) {
            // A chain/asset read failure must not manufacture an ERU balance or hide ERT.
        }
        AlphaSessionStore.VerifiedSession current = sessions.verified();
        if (current == null || !session.lineage().equals(current.lineage()) ||
                !session.ownerId().equals(current.ownerId()) ||
                !date.equals(LocalDate.now().toString()))
            throw new IllegalStateException("Alpha session or day changed");
        return snapshot;
    }
}
