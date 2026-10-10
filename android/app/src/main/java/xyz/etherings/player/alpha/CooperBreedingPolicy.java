package xyz.etherings.player.alpha;

import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

/** One-purpose fail-closed review for the canonical Devnet breeding transaction. */
final class CooperBreedingPolicy {
    private static final String GATEWAY = "Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF";
    private static final String SILVER = "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX";
    private static final String MINT = "2TbJiPQG2WfaDSwmpwmNwe4r9fkTWTaviwQMVhDa4PCj";
    private static final String TREASURY = "CtwMsXbSWhw4FVJVtPGv3vv1CbnEtkmPrHhuzfUzQHGn";
    private static final String HOOK = "5GtUDz7kSuyxgaZNxTG8UHbLhwEshbSfQJgmQypMLkEz";
    private static final String TOKEN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    private static final String COMPUTE = "ComputeBudget111111111111111111111111111111";
    private static final String SYSTEM = "11111111111111111111111111111111";
    private static final String INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
    private static final String GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    private static final byte[] CONFIG_SEED = ascii("eru-config");

    private CooperBreedingPolicy() { }

    static byte[] approvedMessage(JSONObject approved, JSONObject refreshed,
            String firstId, String secondId, String wallet) throws Exception {
        JSONObject initial = approved.getJSONObject("candidate");
        JSONObject candidate = refreshed.getJSONObject("candidate");
        JSONObject before = approved.getJSONObject("terms");
        JSONObject terms = refreshed.getJSONObject("terms");
        if (!before.toString().equals(terms.toString()) ||
                !initial.getString("intentDigest").equals(candidate.getString("intentDigest")) ||
                !initial.getString("operationId").equals(candidate.getString("operationId")) ||
                !initial.getString("reservationId").equals(candidate.getString("reservationId")) ||
                !initial.getString("issuanceId").equals(candidate.getString("issuanceId")) ||
                !wallet.equals(initial.getString("walletAddress")) ||
                !wallet.equals(candidate.getString("walletAddress")) ||
                !GATEWAY.equals(candidate.getString("gatewayProgramId")) ||
                !SILVER.equals(candidate.getString("silverProgramId")) ||
                !"devnet".equals(candidate.getString("cluster")) ||
                !GENESIS.equals(candidate.getString("genesisHash")))
            throw new IllegalArgumentException("Breeding intent or authority changed");
        int firstUses = terms.getInt("firstUses");
        int secondUses = terms.getInt("secondUses");
        if (firstUses < 0 || firstUses > 1 || secondUses < 0 || secondUses > 1 ||
                firstId.equals(secondId) ||
                !firstId.equals(terms.getString("firstRingId")) ||
                !secondId.equals(terms.getString("secondRingId")) ||
                !wallet.equals(terms.getString("walletAddress")) ||
                !MINT.equals(terms.getString("mintAddress")) ||
                !TREASURY.equals(terms.getString("treasuryAddress")) ||
                !candidate.getString("operationId").equals(terms.getString("operationId")) ||
                !candidate.getString("reservationId").equals(terms.getString("reservationId")) ||
                !candidate.getString("issuanceId").equals(terms.getString("issuanceId")) ||
                !candidate.getString("intentDigest").equals(terms.getString("intentDigest")))
            throw new IllegalArgumentException("Breeding terms changed");
        long[][] principals = {{ 30_000_000_000L, 40_000_000_000L },
                { 40_000_000_000L, 50_000_000_000L }};
        long[][] ertCosts = {{ 150, 200 }, { 200, 250 }};
        long principal = principals[firstUses][secondUses];
        long fee = principal / 50;
        long ert = ertCosts[firstUses][secondUses];
        if (!String.valueOf(ert).equals(terms.getString("ertExact")) ||
                !decimal(principal).equals(terms.getString("eruPrincipalExact")) ||
                !decimal(fee).equals(terms.getString("eruFeeExact")) ||
                !decimal(principal + fee).equals(terms.getString("eruTotalExact")))
            throw new IllegalArgumentException("Breeding cost differs from approved matrix");
        byte[] message = Base64.getDecoder().decode(candidate.getString("messageBase64"));
        if (message.length + 129 != candidate.getInt("sizeBytes") ||
                candidate.getInt("sizeBytes") > 1232) throw new IllegalArgumentException("Breeding size invalid");
        Cursor in = new Cursor(message);
        if (in.u8() != 2 || in.u8() != 1 || in.u8() != 11)
            throw new IllegalArgumentException("Breeding signer header changed");
        int count = in.vec();
        if (count < 20 || count > 40) throw new IllegalArgumentException("Breeding accounts changed");
        String[] keys = new String[count];
        for (int i = 0; i < count; i++) keys[i] = SilverOpeningPolicy.address(in.bytes(32));
        if (!wallet.equals(keys[0]) || !candidate.getString("attestorAddress").equals(keys[1]))
            throw new IllegalArgumentException("Breeding signers changed");
        in.bytes(32); // recent blockhash
        if (in.vec() != 2 || !COMPUTE.equals(keys[in.u8()]) || in.vec() != 0 ||
                !Arrays.equals(in.bytes(in.vec()), new byte[] { 2, (byte) 0xc0, 0x5c, 0x15, 0 }))
            throw new IllegalArgumentException("Breeding compute instruction changed");
        if (!GATEWAY.equals(keys[in.u8()]) || in.vec() != 26)
            throw new IllegalArgumentException("Breeding Gateway instruction changed");
        int[] accounts = new int[26];
        for (int i = 0; i < accounts.length; i++) accounts[i] = in.u8();
        byte[] data = in.bytes(in.vec());
        if (!in.done() || data.length != 124 || data[0] != 5 || data[123] != 1 ||
                u64(data, 1) != principal || u64(data, 107) != ert ||
                data[105] != firstUses || data[106] != secondUses ||
                u64(data, 115) != candidate.getLong("configEpoch") ||
                u64(data, 9) != candidate.getLong("nonce") ||
                u64(data, 17) != candidate.getLong("expirySlot") ||
                !Arrays.equals(uuid(candidate.getString("operationId")),
                        Arrays.copyOfRange(data, 25, 41)) ||
                !Arrays.equals(uuid(candidate.getString("reservationId")),
                        Arrays.copyOfRange(data, 41, 57)) ||
                !Arrays.equals(uuid(firstId), Arrays.copyOfRange(data, 73, 89)) ||
                !Arrays.equals(uuid(secondId), Arrays.copyOfRange(data, 89, 105)))
            throw new IllegalArgumentException("Breeding message differs from terms");
        String config = pda(GATEWAY, CONFIG_SEED);
        String replay = pda(GATEWAY, ascii("nonce"), key(config), key(wallet));
        String operationReplay = pda(GATEWAY, ascii("cooper-breeding"),
                key(config), key(wallet), uuid(candidate.getString("operationId")));
        String issuer = pda(GATEWAY, ascii("cooper-breeding-issuer"));
        String boxMint = pda(SILVER, ascii("silver-mint"),
                hex(candidate.getString("issuanceId")));
        String[] expected = {
                AssociatedTokenAddress.derive(wallet, TOKEN, MINT), MINT, TREASURY,
                TREASURY, wallet, candidate.getString("attestorAddress"), config,
                pda(HOOK, ascii("extra-account-metas"), key(MINT)), INSTRUCTIONS,
                TOKEN, HOOK, replay, wallet, SYSTEM, operationReplay, issuer, SILVER,
                pda(SILVER, ascii("silver-config")), boxMint,
                pda(SILVER, ascii("silver-state"), key(boxMint)),
                pda(SILVER, ascii("silver-breeding-box-token"),
                        hex(candidate.getString("issuanceId"))),
                pda(SILVER, ascii("silver-authority")),
                pda(SILVER, ascii("silver-collection")),
                pda(SILVER, ascii("extra-account-metas"), key(boxMint)),
                pda(SILVER, ascii("silver-lifecycle"), key(boxMint)),
                pda(SILVER, ascii("silver-nft-series"), new byte[] { 1 }, new byte[] { 1 })
        };
        for (int i = 0; i < expected.length; i++)
            if (!expected[i].equals(keys[accounts[i]]))
                throw new IllegalArgumentException("Breeding account graph changed: " + i);
        return message;
    }

    private static String decimal(long value) {
        return String.format(java.util.Locale.ROOT, "%d.%09d",
                value / 1_000_000_000L, value % 1_000_000_000L);
    }
    private static byte[] ascii(String value) { return value.getBytes(StandardCharsets.US_ASCII); }
    private static byte[] key(String value) { return AssociatedTokenAddress.decode(value); }
    private static String pda(String program, byte[]... seeds) {
        return AssociatedTokenAddress.deriveProgramAddress(program, seeds);
    }
    private static byte[] uuid(String value) {
        UUID.fromString(value);
        return hex(value.replace("-", ""));
    }
    private static byte[] hex(String value) {
        if (!value.matches("[a-f0-9]+") || value.length() % 2 != 0)
            throw new IllegalArgumentException("Invalid breeding hex");
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < out.length; i++)
            out[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
    private static long u64(byte[] data, int offset) {
        long value = 0;
        for (int i = 7; i >= 0; i--) value = (value << 8) | (data[offset + i] & 0xffL);
        return value;
    }
    private static final class Cursor {
        final byte[] data;
        int offset;
        Cursor(byte[] data) { this.data = data; }
        int u8() {
            if (offset >= data.length) throw new IllegalArgumentException("Truncated breeding message");
            return data[offset++] & 0xff;
        }
        int vec() {
            int result = 0;
            for (int i = 0; i < 3; i++) {
                int part = u8(); result |= (part & 127) << (i * 7);
                if ((part & 128) == 0) return result;
            }
            throw new IllegalArgumentException("Invalid breeding vector");
        }
        byte[] bytes(int count) {
            if (count < 0 || offset + count > data.length)
                throw new IllegalArgumentException("Truncated breeding message");
            byte[] result = Arrays.copyOfRange(data, offset, offset + count);
            offset += count;
            return result;
        }
        boolean done() { return offset == data.length; }
    }
}
