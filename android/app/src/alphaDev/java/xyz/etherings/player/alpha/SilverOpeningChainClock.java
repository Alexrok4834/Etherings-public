package xyz.etherings.player.alpha;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

final class SilverOpeningChainClock {
    private final String rpc;
    private final String trustedGenesis;

    SilverOpeningChainClock(String rpc) {
        String trustedGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
        AlphaEndpointPolicy.requireDevnetRpc(rpc, BuildConfig.ALPHA_SILVER_RPC_URL,
                BuildConfig.ALPHA_DEV_API_BASE_URL);
        if (trustedGenesis.isEmpty())
            throw new IllegalArgumentException("Unapproved Silver opening chain anchor");
        this.rpc = rpc;
        this.trustedGenesis = trustedGenesis;
    }

    void requireCurrent(SilverOpeningPolicy policy, SilverOpeningPolicy.Decoded decoded,
            long lastValidBlockHeight)
            throws Exception {
        String genesis = call("getGenesisHash", new JSONArray()).getString("result");
        if (!trustedGenesis.equals(genesis))
            throw new IllegalArgumentException("Silver opening cluster mismatch");
        JSONArray params = new JSONArray().put(decoded.blockhash).put(
                new JSONObject().put("commitment", "confirmed"));
        boolean valid = call("isBlockhashValid", params).getJSONObject("result")
                .getBoolean("value");
        long height = call("getBlockHeight", new JSONArray().put(
                new JSONObject().put("commitment", "confirmed"))).getLong("result");
        SilverOpeningFreshness.require(trustedGenesis, genesis, decoded.blockhash,
                params.getString(0), lastValidBlockHeight, height, valid);
        requireState(policy);
        // A cluster switch between RPC calls must not turn a stale result into approval.
        if (!trustedGenesis.equals(call("getGenesisHash", new JSONArray()).getString("result")))
            throw new IllegalArgumentException("Silver opening cluster changed");
    }

    private void requireState(SilverOpeningPolicy policy) throws Exception {
        String silver = policy.value("silver");
        String token = policy.value("token");
        JSONObject program = account(silver);
        JSONObject source = account(policy.value("source"));
        JSONObject escrow = account(policy.value("escrow"));
        JSONObject state = account(policy.value("state"));
        JSONObject lifecycle = account(policy.value("lifecycle"));
        JSONObject config = account(policy.value("config"));
        JSONObject design = account(policy.value("design"));
        JSONObject collection = account(policy.value("collection"));
        JSONObject extra = account(policy.value("extra"));
        JSONObject network = account(policy.value("network"));
        if (program == null || !program.getBoolean("executable") ||
                source == null || escrow == null || state == null || lifecycle == null ||
                config == null || design == null || collection == null || extra == null ||
                network == null ||
                !token.equals(source.getString("owner")) ||
                !token.equals(escrow.getString("owner")) ||
                !silver.equals(state.getString("owner")) ||
                !silver.equals(lifecycle.getString("owner")) ||
                !silver.equals(config.getString("owner")) ||
                !silver.equals(design.getString("owner")) ||
                !silver.equals(collection.getString("owner")) ||
                !silver.equals(extra.getString("owner")) ||
                !policy.value("orao").equals(network.getString("owner")) ||
                account(policy.value("operation")) != null ||
                account(policy.value("request")) != null)
            throw new IllegalArgumentException("Silver opening chain accounts changed");
        byte[] src = data(source), dst = data(escrow), box = data(state);
        byte[] life = data(lifecycle), cfg = data(config), set = data(design), net = data(network);
        if (src.length < 72 || dst.length < 72 || box.length != 204 ||
                life.length != 128 || cfg.length != 145 || set.length < 104 || net.length < 72 ||
                !policy.value("mint").equals(SilverOpeningPolicy.address(
                        Arrays.copyOfRange(src, 0, 32))) ||
                !policy.value("mint").equals(SilverOpeningPolicy.address(
                        Arrays.copyOfRange(dst, 0, 32))) ||
                !policy.value("authority").equals(SilverOpeningPolicy.address(
                        Arrays.copyOfRange(src, 32, 64))) ||
                !policy.value("escrowAuthority").equals(SilverOpeningPolicy.address(
                        Arrays.copyOfRange(dst, 32, 64))) ||
                u64(src, 64) != 1 || u64(dst, 64) != 0 ||
                box[0] != 3 || box[1] != 1 || box[2] != 1 || box[3] != 1 ||
                !policy.value("mint").equals(SilverOpeningPolicy.address(
                        Arrays.copyOfRange(box, 36, 68))) ||
                !Arrays.equals(Arrays.copyOfRange(life, 0, 8),
                        new byte[] { 0x45, 0x52, 0x53, 0x42, 0x4c, 0x56, 0x31, 0 }) ||
                life[8] != 1 || life[9] != 0 ||
                !policy.value("mint").equals(SilverOpeningPolicy.address(
                        Arrays.copyOfRange(life, 16, 48))) ||
                u64(life, 48) < 1 || cfg[0] != 2 ||
                !policy.value("design").equals(SilverOpeningPolicy.address(
                        Arrays.copyOfRange(cfg, 73, 105))) ||
                u64(cfg, 105) != u64(set, 16) ||
                set[8] != 1 || set[9] != 1 ||
                !Arrays.equals(Arrays.copyOfRange(set, 0, 8),
                        new byte[] { 0x45, 0x52, 0x53, 0x44, 0x53, 0x56, 0x31, 0 }) ||
                !Arrays.equals(Arrays.copyOfRange(cfg, 113, 145),
                        Arrays.copyOfRange(set, 56, 88)) ||
                !policy.value("treasury").equals(SilverOpeningPolicy.address(
                        Arrays.copyOfRange(net, 40, 72))))
            throw new IllegalArgumentException("Silver opening Box state changed");
        requireDerivedAccounts(policy, u64(life, 48), u64(cfg, 105));
    }

    static void requireDerivedAccounts(SilverOpeningPolicy policy, long operation,
            long version) throws Exception {
        if (operation < 1 || version < 1) throw new IllegalArgumentException("Invalid opening state");
        String silver = policy.value("silver"), mint = policy.value("mint");
        byte[] rawMint = AssociatedTokenAddress.decode(mint);
        byte[] seed = hex32(policy.value("seedHex"));
        String escrowAuthority = pda(silver, "silver-escrow", rawMint);
        if (!policy.value("config").equals(pda(silver, "silver-config")) ||
                !policy.value("collection").equals(pda(silver, "silver-collection")) ||
                !policy.value("design").equals(pda(silver, "silver-design-set", u64Bytes(version))) ||
                !policy.value("state").equals(pda(silver, "silver-state", rawMint)) ||
                !policy.value("lifecycle").equals(pda(silver, "silver-lifecycle", rawMint)) ||
                !policy.value("operation").equals(pda(silver, "silver-open", rawMint,
                        u64Bytes(operation))) ||
                !policy.value("extra").equals(pda(silver, "extra-account-metas", rawMint)) ||
                !policy.value("escrowAuthority").equals(escrowAuthority) ||
                !policy.value("escrow").equals(AssociatedTokenAddress.derive(
                        escrowAuthority, policy.value("token"), mint)) ||
                !policy.value("network").equals(pda(policy.value("orao"),
                        "orao-vrf-network-configuration")) ||
                !policy.value("request").equals(pda(policy.value("orao"),
                        "orao-vrf-randomness-request", seed)))
            throw new IllegalArgumentException("Silver opening PDA mismatch");
    }

    private static String pda(String program, String label, byte[]... extra) {
        byte[][] seeds = new byte[extra.length + 1][];
        seeds[0] = label.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(extra, 0, seeds, 1, extra.length);
        return AssociatedTokenAddress.deriveProgramAddress(program, seeds);
    }

    private static byte[] u64Bytes(long value) {
        byte[] raw = new byte[8];
        for (int i = 0; i < 8; i++) raw[i] = (byte) (value >>> (8 * i));
        return raw;
    }

    private static byte[] hex32(String value) {
        if (!value.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid seed");
        byte[] raw = new byte[32];
        for (int i = 0; i < 32; i++)
            raw[i] = (byte) Integer.parseInt(value.substring(2 * i, 2 * i + 2), 16);
        return raw;
    }

    private JSONObject account(String address) throws Exception {
        return call("getAccountInfo", new JSONArray().put(address).put(
                new JSONObject().put("encoding", "base64").put("commitment", "finalized")))
                .getJSONObject("result").optJSONObject("value");
    }

    private static byte[] data(JSONObject account) throws Exception {
        JSONArray encoded = account.getJSONArray("data");
        if (!"base64".equals(encoded.getString(1)))
            throw new IllegalArgumentException("Unexpected Silver account encoding");
        return Base64.getDecoder().decode(encoded.getString(0));
    }

    private static long u64(byte[] bytes, int start) {
        long value = 0;
        for (int i = 0; i < 8; i++) value |= (bytes[start + i] & 255L) << (8 * i);
        return value;
    }

    private JSONObject call(String method, JSONArray params) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(rpc).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(5_000);
        connection.setReadTimeout(5_000);
        connection.setInstanceFollowRedirects(false);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] body = new JSONObject().put("jsonrpc", "2.0").put("id", 1)
                .put("method", method).put("params", params).toString()
                .getBytes(StandardCharsets.UTF_8);
        try {
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            if (connection.getResponseCode() != 200)
                throw new IllegalStateException("Silver opening RPC unavailable");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] chunk = new byte[1024];
                int count;
                while ((count = input.read(chunk)) != -1) {
                    if (output.size() + count > 16_384)
                        throw new IllegalStateException("Silver opening RPC response too large");
                    output.write(chunk, 0, count);
                }
            }
            JSONObject response = new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
            if (response.has("error") || response.getInt("id") != 1 ||
                    !"2.0".equals(response.getString("jsonrpc")) ||
                    !response.has("result"))
                throw new IllegalStateException("Silver opening RPC rejected request");
            return response;
        } finally { connection.disconnect(); }
    }
}
