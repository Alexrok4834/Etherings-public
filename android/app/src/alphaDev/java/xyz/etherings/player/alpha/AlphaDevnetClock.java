package xyz.etherings.player.alpha;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import xyz.etherings.player.BuildConfig;

final class AlphaDevnetClock {
    private static final String RPC = BuildConfig.ALPHA_SILVER_RPC_URL;
    private static final String GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

    long confirmedSlot() throws Exception {
        if (!GENESIS.equals(call("getGenesisHash", new JSONArray()).getString("result")))
            throw new IllegalArgumentException("Unexpected Solana cluster");
        return call("getSlot", new JSONArray().put(
                new JSONObject().put("commitment", "confirmed"))).getLong("result");
    }

    void requireFreshBlockhash(String blockhash) throws Exception {
        JSONObject response = call("isBlockhashValid", new JSONArray().put(blockhash).put(
                new JSONObject().put("commitment", "confirmed")));
        if (!response.getJSONObject("result").getBoolean("value"))
            throw new IllegalArgumentException("Recent blockhash expired");
    }

    private JSONObject call(String method, JSONArray params) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(RPC).openConnection();
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
                throw new IllegalStateException("Devnet RPC unavailable");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] chunk = new byte[1024];
                int count;
                while ((count = input.read(chunk)) != -1) {
                    if (output.size() + count > 16_384)
                        throw new IllegalStateException("Devnet RPC response too large");
                    output.write(chunk, 0, count);
                }
            }
            JSONObject response = new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
            if (response.has("error")) throw new IllegalStateException("Devnet RPC rejected request");
            return response;
        } finally { connection.disconnect(); }
    }
}
