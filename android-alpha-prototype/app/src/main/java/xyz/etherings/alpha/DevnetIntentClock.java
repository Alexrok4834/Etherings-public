package xyz.etherings.alpha;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class DevnetIntentClock {
    private static final String PUBLIC_RPC = "https://api.devnet.solana.com";
    private static final String GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    private final String rpc;

    DevnetIntentClock() { rpc = PUBLIC_RPC; }

    DevnetIntentClock(String rpc) {
        if (!"http://127.0.0.1:19082".equals(rpc))
            throw new IllegalArgumentException("Unapproved Silver proof RPC");
        this.rpc = rpc;
    }

    long confirmedSlot() throws Exception {
        if (!GENESIS.equals(call("getGenesisHash", new JSONArray()).getString("result")))
            throw new IllegalArgumentException("Unexpected Solana cluster");
        JSONArray params = new JSONArray().put(new JSONObject().put("commitment", "confirmed"));
        return call("getSlot", params).getLong("result");
    }

    void requireFreshBlockhash(String blockhash) throws Exception {
        JSONArray params = new JSONArray().put(blockhash)
                .put(new JSONObject().put("commitment", "confirmed"));
        if (!call("isBlockhashValid", params).getJSONObject("result").getBoolean("value"))
            throw new IllegalArgumentException("Recent blockhash expired");
    }

    void requireFreshBlockhash(String blockhash, long minContextSlot) throws Exception {
        if (minContextSlot <= 0) throw new IllegalArgumentException("Invalid RPC context slot");
        JSONArray params = new JSONArray().put(blockhash)
                .put(new JSONObject().put("commitment", "confirmed")
                        .put("minContextSlot", minContextSlot));
        Exception last = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            try {
                if (call("isBlockhashValid", params).getJSONObject("result").getBoolean("value"))
                    return;
                last = new IllegalArgumentException("Recent blockhash expired");
            } catch (Exception error) { last = error; }
            if (attempt < 3) Thread.sleep(500);
        }
        throw last;
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
            if (connection.getResponseCode() != 200) throw new IllegalStateException("Devnet RPC unavailable");
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
