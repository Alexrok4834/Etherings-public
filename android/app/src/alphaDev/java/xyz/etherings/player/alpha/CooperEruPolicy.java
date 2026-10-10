package xyz.etherings.player.alpha;

import org.json.JSONObject;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

/** Fail-closed review of the two approved canonical Devnet ERU level transitions. */
final class CooperEruPolicy {
    static final String GATEWAY = "Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF";
    static final String MINT = "2TbJiPQG2WfaDSwmpwmNwe4r9fkTWTaviwQMVhDa4PCj";
    static final String TREASURY = "CtwMsXbSWhw4FVJVtPGv3vv1CbnEtkmPrHhuzfUzQHGn";
    private static final String COMPUTE = "ComputeBudget111111111111111111111111111111";
    static final String HOOK = "5GtUDz7kSuyxgaZNxTG8UHbLhwEshbSfQJgmQypMLkEz";
    static final String CONFIG = "4PwMMCGG49WNaRvRnqKYwiYQZkoX2SS9wg5CJDFSVn8j";
    static final String TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    private static final String GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

    private CooperEruPolicy() { }

    static byte[] approvedMessage(JSONObject approved, JSONObject refreshed,
            String ringId, int current, String wallet) throws Exception {
        if ((current != 4 && current != 19) || !approved.getJSONObject("terms").toString().equals(
                refreshed.getJSONObject("terms").toString()))
            throw new IllegalArgumentException("Cooper economic intent changed");
        long principal = current == 4 ? 30_000_000_000L : 60_000_000_000L;
        long ertCost = current == 4 ? 24 : 84;
        String principalExact = current == 4 ? "30.000000000" : "60.000000000";
        String feeExact = current == 4 ? "0.600000000" : "1.200000000";
        JSONObject first = approved.getJSONObject("candidate");
        JSONObject next = refreshed.getJSONObject("candidate");
        if (!first.getString("intentDigest").equals(next.getString("intentDigest")) ||
                !first.getString("operationId").equals(next.getString("operationId")) ||
                !first.getString("reservationId").equals(next.getString("reservationId")) ||
                !wallet.equals(first.getString("walletAddress")) ||
                !wallet.equals(next.getString("walletAddress")) ||
                !GATEWAY.equals(next.getString("gatewayProgramId")) ||
                !"devnet".equals(next.getString("cluster")) ||
                !GENESIS.equals(next.getString("genesisHash")))
            throw new IllegalArgumentException("Cooper authority or intent changed");
        JSONObject terms = refreshed.getJSONObject("terms");
        if (!ringId.equals(terms.getString("ringId")) ||
                terms.getInt("currentLevel") != current ||
                terms.getInt("targetLevel") != current + 1 ||
                !String.valueOf(ertCost).equals(terms.getString("ertExact")) ||
                !principalExact.equals(terms.getString("eruPrincipalExact")) ||
                !feeExact.equals(terms.getString("eruFeeExact")) ||
                !MINT.equals(terms.getString("mintAddress")) ||
                !TREASURY.equals(terms.getString("treasuryAddress")) ||
                !wallet.equals(terms.getString("walletAddress")))
            throw new IllegalArgumentException("Cooper payment differs from review");
        byte[] message = Base64.getDecoder().decode(next.getString("messageBase64"));
        if (message.length + 129 != next.getInt("sizeBytes") ||
                next.getInt("sizeBytes") > 1232 || message.length < 100)
            throw new IllegalArgumentException("Cooper message size invalid");
        Cursor in = new Cursor(message);
        int signers = in.u8(), signedReadonly = in.u8();
        in.u8();
        if (signers != 2 || signedReadonly != 1) throw new IllegalArgumentException("Cooper signer graph changed");
        int count = in.vec();
        if (count < 15 || count > 32) throw new IllegalArgumentException("Cooper accounts changed");
        String[] keys = new String[count];
        for (int i = 0; i < count; i++) keys[i] = SilverOpeningPolicy.address(in.bytes(32));
        if (!wallet.equals(keys[0]) || !next.getString("attestorAddress").equals(keys[1]))
            throw new IllegalArgumentException("Cooper signers changed");
        in.bytes(32);
        if (in.vec() != 2) throw new IllegalArgumentException("Cooper instructions changed");
        if (!COMPUTE.equals(keys[in.u8()]) || in.vec() != 0 ||
                !Arrays.equals(in.bytes(in.vec()), new byte[] { 2, (byte) 0xc0, 0x27, 0x09, 0 }))
            throw new IllegalArgumentException("Cooper compute instruction changed");
        if (!GATEWAY.equals(keys[in.u8()]) || in.vec() != 15)
            throw new IllegalArgumentException("Cooper Gateway instruction changed");
        int[] accounts = new int[15];
        for (int i = 0; i < accounts.length; i++) accounts[i] = in.u8();
        byte[] data = in.bytes(in.vec());
        if (!in.done() || data.length != 108 || data[0] != 1 ||
                !AssociatedTokenAddress.derive(wallet, TOKEN_2022, MINT)
                        .equals(keys[accounts[0]]) ||
                !MINT.equals(keys[accounts[1]]) || !TREASURY.equals(keys[accounts[2]]) ||
                !TREASURY.equals(keys[accounts[3]]) ||
                !wallet.equals(keys[accounts[4]]) || !wallet.equals(keys[accounts[12]]) ||
                !next.getString("attestorAddress").equals(keys[accounts[5]]) ||
                !CONFIG.equals(keys[accounts[6]]) ||
                !TOKEN_2022.equals(keys[accounts[9]]) ||
                !HOOK.equals(keys[accounts[10]]) ||
                !Arrays.equals(uuidBytes(next.getString("operationId")),
                        Arrays.copyOfRange(data, 25, 41)) ||
                !Arrays.equals(uuidBytes(next.getString("reservationId")),
                        Arrays.copyOfRange(data, 41, 57)) ||
                !Arrays.equals(uuidBytes(ringId), Arrays.copyOfRange(data, 57, 73)) ||
                data[89] != current || data[90] != current + 1 || data[99] != 1 ||
                u64(data, 1) != principal || u64(data, 91) != ertCost ||
                u64(data, 100) != 1)
            throw new IllegalArgumentException("Cooper transaction differs from approved payment");
        return message;
    }

    private static byte[] uuidBytes(String value) {
        UUID.fromString(value);
        String hex = value.replace("-", "");
        byte[] result = new byte[16];
        for (int i = 0; i < 16; i++) result[i] =
                (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return result;
    }

    private static long u64(byte[] bytes, int offset) {
        long value = 0;
        for (int i = 7; i >= 0; i--) value = (value << 8) | (bytes[offset + i] & 0xffL);
        return value;
    }

    private static final class Cursor {
        final byte[] data;
        int offset;
        Cursor(byte[] data) { this.data = data; }
        int u8() { if (offset >= data.length) throw new IllegalArgumentException("Truncated Cooper message");
            return data[offset++] & 0xff; }
        int vec() { int value = 0;
            for (int i = 0; i < 3; i++) { int part = u8(); value |= (part & 127) << (7 * i);
                if ((part & 128) == 0) return value; }
            throw new IllegalArgumentException("Invalid Cooper vector"); }
        byte[] bytes(int count) { if (count < 0 || offset + count > data.length)
                throw new IllegalArgumentException("Truncated Cooper message");
            byte[] result = Arrays.copyOfRange(data, offset, offset + count); offset += count; return result; }
        boolean done() { return offset == data.length; }
    }
}
