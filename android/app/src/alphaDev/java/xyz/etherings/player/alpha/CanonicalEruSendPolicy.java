package xyz.etherings.player.alpha;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;
import xyz.etherings.player.alpha.wallet.GatewayMessagePolicy;

/** Independent canonical identities for Wallet review of a dynamic Send candidate. */
final class CanonicalEruSendPolicy {
    private static final String SYSTEM = "11111111111111111111111111111111";
    private static final String SYSVAR = "Sysvar1nstructions1111111111111111111111111";
    private final GatewayMessagePolicy messagePolicy;

    CanonicalEruSendPolicy(String wallet, String recipient, long amount) throws Exception {
        if (wallet.equals(recipient) || amount <= 0) throw new IllegalArgumentException("Invalid Send");
        byte[] configSeed = "eru-config".getBytes(StandardCharsets.UTF_8);
        String config = AssociatedTokenAddress.deriveProgramAddress(
                CooperEruPolicy.GATEWAY, configSeed);
        if (!CooperEruPolicy.CONFIG.equals(config))
            throw new IllegalArgumentException("Canonical Gateway config mismatch");
        String source = AssociatedTokenAddress.derive(wallet,
                CooperEruPolicy.TOKEN_2022, CooperEruPolicy.MINT);
        String meta = AssociatedTokenAddress.deriveProgramAddress(CooperEruPolicy.HOOK,
                "extra-account-metas".getBytes(StandardCharsets.UTF_8),
                AssociatedTokenAddress.decode(CooperEruPolicy.MINT));
        String replay = AssociatedTokenAddress.deriveProgramAddress(CooperEruPolicy.GATEWAY,
                "nonce".getBytes(StandardCharsets.UTF_8),
                AssociatedTokenAddress.decode(config), AssociatedTokenAddress.decode(wallet));
        JSONObject expected = new JSONObject().put("cluster", "devnet")
                .put("authority", wallet).put("source", source)
                .put("treasury", CooperEruPolicy.TREASURY).put("config", config)
                .put("replay", replay).put("mint", CooperEruPolicy.MINT)
                .put("meta", meta).put("sysvar", SYSVAR)
                .put("tokenProgram", CooperEruPolicy.TOKEN_2022)
                .put("hook", CooperEruPolicy.HOOK).put("systemProgram", SYSTEM)
                .put("gateway", CooperEruPolicy.GATEWAY);
        messagePolicy = new GatewayMessagePolicy(expected, recipient, amount);
    }

    GatewayMessagePolicy.Decoded validate(byte[] message, long confirmedSlot) throws Exception {
        return messagePolicy.validate(message, confirmedSlot);
    }

    GatewayMessagePolicy.Decoded requireSameCandidate(JSONObject response, String intentId,
            byte[] approvedMessage, long confirmedSlot) throws Exception {
        if (!"devnet".equals(response.getString("cluster")) ||
                !intentId.equals(response.getString("id")))
            throw new IllegalArgumentException("Send intent changed after review");
        byte[] current = Base64.getDecoder().decode(response.getString("message"));
        if (!Arrays.equals(approvedMessage, current))
            throw new IllegalArgumentException("Send message changed after review");
        return validate(current, confirmedSlot);
    }
}
