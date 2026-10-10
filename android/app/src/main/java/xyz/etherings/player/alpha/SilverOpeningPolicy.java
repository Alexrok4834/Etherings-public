package xyz.etherings.player.alpha;

import org.json.JSONObject;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;

import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

public final class SilverOpeningPolicy {
    private static final String ALPHABET =
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static final String COMPUTE = "ComputeBudget111111111111111111111111111111";
    private static final String TOKEN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    private static final String MARKET = "BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j";
    private static final String ORAO = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y";
    private static final String INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
    private static final String SYSTEM = "11111111111111111111111111111111";
    private static final String[] OPEN = { "authority", "mint", "source", "escrow",
            "state", "lifecycle", "extra", "operation", "config", "design",
            "collection", "network", "treasury", "request", "orao", "token",
            "instructions", "system" };
    private static final String[] TRANSFER = { "source", "mint", "escrow", "authority",
            "extra", "state", "lifecycle", "silver" };
    private static final String[] MARKET_OPEN = { "authority", "mint", "source", "escrow",
            "state", "lifecycle", "extra", "operation", "config", "design",
            "collection", "network", "treasury", "request", "orao", "token",
            "instructions", "system", "market", "listing" };
    private static final String[] MARKET_TRANSFER = { "source", "mint", "escrow", "authority",
            "extra", "state", "lifecycle", "market", "listing", "silver" };
    private final JSONObject pinned;

    SilverOpeningPolicy(JSONObject pinned) { this.pinned = pinned; }

    static SilverOpeningPolicy forReview(JSONObject candidate, String wallet, String mint,
            String escrow, String program) throws Exception {
        byte[] message = Base64.getDecoder().decode(candidate.getString("messageBase64"));
        require(message.length + 65 <= 1232, "oversized candidate transaction");
        Cursor in = new Cursor(message);
        in.bytes(3);
        int count = in.shortVec();
        require(count == 20 || count == 22, "unexpected account count");
        String[] keys = new String[count];
        for (int i = 0; i < count; i++) keys[i] = base58(in.bytes(32));
        in.bytes(32);
        require(in.shortVec() == 4, "unexpected instruction count");
        String compute = key(keys, in.u8());
        int computeAccounts = in.shortVec();
        in.bytes(computeAccounts);
        in.bytes(in.shortVec());
        String silver = key(keys, in.u8());
        boolean marketAware = count == 22;
        require(in.shortVec() == (marketAware ? MARKET_OPEN.length : OPEN.length),
                "unexpected Silver account count");
        JSONObject policy = new JSONObject();
        for (String field : OPEN) policy.put(field, key(keys, in.u8()));
        if (marketAware) {
            policy.put("market", key(keys, in.u8()));
            policy.put("listing", key(keys, in.u8()));
            require(MARKET.equals(policy.getString("market")) &&
                    AssociatedTokenAddress.deriveProgramAddress(MARKET,
                            "silver-market-listing".getBytes(StandardCharsets.US_ASCII),
                            AssociatedTokenAddress.decode(mint))
                            .equals(policy.getString("listing")),
                    "Silver marketplace listing mismatch");
        }
        policy.put("silver", silver).put("compute", compute)
                .put("cluster", "devnet").put("seedHex", candidate.getString("seedHex"));
        policy.put("escrowAuthority", AssociatedTokenAddress.deriveProgramAddress(silver,
                "silver-escrow".getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                AssociatedTokenAddress.decode(mint)));
        require(wallet.equals(policy.getString("authority")) &&
                mint.equals(policy.getString("mint")) &&
                escrow.equals(policy.getString("escrow")) &&
                program.equals(silver), "Silver review identity mismatch");
        return new SilverOpeningPolicy(policy);
    }

    Decoded validateResponse(JSONObject response) throws Exception {
        require(response.getBoolean("testOnly") &&
                value("cluster").equals(response.getString("cluster")) &&
                value("authority").equals(response.getString("walletAddress")) &&
                value("mint").equals(response.getString("mintAddress")) &&
                value("operation").equals(response.getString("operation")) &&
                value("request").equals(response.getString("request")) &&
                value("seedHex").equals(response.getString("seedHex")) &&
                response.getLong("lastValidBlockHeight") > 0,
                "candidate envelope mismatch");
        String encoded = response.getString("messageBase64");
        byte[] message = Base64.getDecoder().decode(encoded);
        require(Base64.getEncoder().encodeToString(message).equals(encoded),
                "noncanonical candidate message encoding");
        return validate(message);
    }

    public byte[] requireApprovedMessage(JSONObject response, String expectedWallet) throws Exception {
        Decoded decoded = validateResponse(response);
        require(expectedWallet.equals(decoded.authority), "Opening authority is not the bound wallet");
        return decoded.message();
    }

    Decoded validate(byte[] message) throws Exception {
        require("devnet".equals(pinned.getString("cluster")), "wrong cluster");
        require(TOKEN.equals(pinned.getString("token")) && ORAO.equals(pinned.getString("orao"))
                && COMPUTE.equals(pinned.getString("compute"))
                && INSTRUCTIONS.equals(pinned.getString("instructions"))
                && SYSTEM.equals(pinned.getString("system")), "program identity mismatch");
        byte[] seed = hex32(pinned.getString("seedHex"));
        require(!Arrays.equals(seed, new byte[32]), "empty seed");
        Cursor in = new Cursor(message);
        int signers = in.u8(), readonlySigned = in.u8(), readonlyUnsigned = in.u8();
        require(signers == 1 && readonlySigned == 0, "unexpected signer header/version");
        int count = in.shortVec();
        boolean marketAware = pinned.has("market");
        require(count == (marketAware ? 22 : 20) &&
                readonlyUnsigned == (marketAware ? 12 : 11),
                "unexpected account count/roles");
        String[] keys = new String[count];
        Set<String> actual = new HashSet<>(), expected = new HashSet<>();
        for (int i = 0; i < count; i++) {
            keys[i] = base58(in.bytes(32));
            require(actual.add(keys[i]), "duplicate account key");
        }
        for (String field : OPEN) expected.add(value(field));
        if (marketAware) {
            require(MARKET.equals(value("market")) &&
                    AssociatedTokenAddress.deriveProgramAddress(MARKET,
                            "silver-market-listing".getBytes(StandardCharsets.US_ASCII),
                            AssociatedTokenAddress.decode(value("mint")))
                            .equals(value("listing")), "Silver marketplace listing mismatch");
            expected.add(value("market"));
            expected.add(value("listing"));
        }
        expected.add(value("silver"));
        expected.add(value("compute"));
        require(expected.size() == count && actual.equals(expected), "unknown/missing account");
        require(keys[0].equals(value("authority")), "fee payer is not bound wallet");
        Set<String> writable = new HashSet<>(Arrays.asList(value("authority"),
                value("source"), value("escrow"), value("state"), value("lifecycle"),
                value("operation"), value("network"), value("treasury"), value("request")));
        if (marketAware) writable.add(value("listing"));
        for (int i = 0; i < count; i++) {
            boolean signer = i < signers;
            boolean write = i < count - readonlyUnsigned;
            require(signer == keys[i].equals(value("authority")), "unexpected signer");
            require(write == writable.contains(keys[i]), "unexpected writable account");
        }
        byte[] blockhash = in.bytes(32);
        require(!Arrays.equals(blockhash, new byte[32]), "empty blockhash");
        require(in.shortVec() == 4, "additional/missing instruction");
        instruction(in, keys, "compute", new String[0], new byte[] { 2, 32, (byte) 0xd6, 19, 0 });
        byte[] prepare = new byte[33];
        prepare[0] = 12;
        System.arraycopy(seed, 0, prepare, 1, 32);
        instruction(in, keys, "silver", marketAware ? MARKET_OPEN : OPEN, prepare);
        instruction(in, keys, "token", marketAware ? MARKET_TRANSFER : TRANSFER,
                new byte[] { 12, 1, 0, 0, 0, 0, 0, 0, 0, 0 });
        prepare[0] = 13;
        instruction(in, keys, "silver", marketAware ? MARKET_OPEN : OPEN, prepare);
        require(in.atEnd(), "trailing message bytes");
        return new Decoded(message, value("authority"), value("mint"), value("escrow"),
                value("request"), base58(blockhash));
    }

    private void instruction(Cursor in, String[] keys, String program, String[] accounts,
            byte[] data) throws Exception {
        require(key(keys, in.u8()).equals(value(program)), "instruction program mismatch");
        require(in.shortVec() == accounts.length, "instruction account count mismatch");
        for (String field : accounts)
            require(key(keys, in.u8()).equals(value(field)), "instruction account mismatch: " + field);
        require(Arrays.equals(in.bytes(in.shortVec()), data), "instruction data mismatch");
    }

    String value(String field) throws Exception { return pinned.getString(field); }

    static String address(byte[] bytes) { return base58(bytes); }

    static final class Decoded {
        final String authority, mint, escrow, request, blockhash;
        private final byte[] message;

        Decoded(byte[] message, String authority, String mint, String escrow,
                String request, String blockhash) {
            this.message = Arrays.copyOf(message, message.length);
            this.authority = authority;
            this.mint = mint;
            this.escrow = escrow;
            this.request = request;
            this.blockhash = blockhash;
        }

        byte[] message() { return Arrays.copyOf(message, message.length); }
    }

    private static byte[] hex32(String hex) {
        require(hex.matches("[0-9a-f]{64}"), "invalid seed");
        byte[] result = new byte[32];
        for (int i = 0; i < 32; i++)
            result[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return result;
    }

    private static String key(String[] keys, int i) {
        require(i >= 0 && i < keys.length, "bad account index");
        return keys[i];
    }

    private static void require(boolean okay, String reason) {
        if (!okay) throw new IllegalArgumentException(reason);
    }

    private static String base58(byte[] bytes) {
        int leading = 0;
        while (leading < bytes.length && bytes[leading] == 0) leading++;
        BigInteger n = new BigInteger(1, bytes);
        StringBuilder out = new StringBuilder();
        while (n.signum() > 0) {
            BigInteger[] div = n.divideAndRemainder(BigInteger.valueOf(58));
            out.append(ALPHABET.charAt(div[1].intValue()));
            n = div[0];
        }
        for (int i = 0; i < leading; i++) out.append('1');
        return out.reverse().toString();
    }

    private static final class Cursor {
        final byte[] bytes;
        int position;

        Cursor(byte[] bytes) { this.bytes = bytes; }

        int u8() {
            require(position < bytes.length, "truncated message");
            return bytes[position++] & 255;
        }

        int shortVec() {
            int value = 0;
            for (int i = 0; i < 3; i++) {
                int part = u8();
                value |= (part & 127) << (i * 7);
                if ((part & 128) == 0) {
                    require(value <= 256 && (i == 0 || value >= (1 << (i * 7))),
                            "noncanonical/oversized vector");
                    return value;
                }
            }
            throw new IllegalArgumentException("invalid vector length");
        }

        byte[] bytes(int count) {
            require(count >= 0 && count <= bytes.length - position, "truncated field");
            byte[] out = Arrays.copyOfRange(bytes, position, position + count);
            position += count;
            return out;
        }

        boolean atEnd() { return position == bytes.length; }
    }
}
