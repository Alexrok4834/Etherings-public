package xyz.etherings.player.alpha;

import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

/** Exact, Silver-specific wallet review; Cooper UUID/Gateway policy is unchanged. */
final class SilverProgressionPolicy {
    private static final String PROGRAM = "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX";
    private static final String COMPUTE = "ComputeBudget111111111111111111111111111111";
    private static final String GATEWAY = "Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF";
    private static final String ERU_MINT = "2TbJiPQG2WfaDSwmpwmNwe4r9fkTWTaviwQMVhDa4PCj";
    private static final String ERU_TREASURY = "CtwMsXbSWhw4FVJVtPGv3vv1CbnEtkmPrHhuzfUzQHGn";
    private static final String ERU_HOOK = "5GtUDz7kSuyxgaZNxTG8UHbLhwEshbSfQJgmQypMLkEz";
    private static final String TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    private static final String INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
    private static final String SYSTEM = "11111111111111111111111111111111";
    private static final String GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

    private SilverProgressionPolicy() { }

    static byte[] approvedAllocationMessage(JSONObject approved, JSONObject refreshed,
            String mint, String wallet, JSONObject allocation) throws Exception {
        if (!allocationTermsEqual(approved.getJSONObject("terms"),
                refreshed.getJSONObject("terms")))
            throw new IllegalArgumentException("Silver Points intent changed");
        JSONObject first = approved.getJSONObject("candidate");
        JSONObject next = refreshed.getJSONObject("candidate");
        for (String name : new String[] { "intentDigest", "walletAddress", "mintAddress",
                "tokenAddress", "ringAddress", "programId", "cluster", "genesisHash",
                "level", "unspentPoints", "attributes" })
            if (!first.get(name).toString().equals(next.get(name).toString()))
                throw new IllegalArgumentException("Silver Points candidate changed: " + name);
        if (!allocationEqual(first.getJSONObject("allocation"),
                next.getJSONObject("allocation")))
            throw new IllegalArgumentException("Silver Points allocation changed");
        if (!PROGRAM.equals(next.getString("programId")) ||
                !"devnet".equals(next.getString("cluster")) ||
                !GENESIS.equals(next.getString("genesisHash")) ||
                !mint.equals(next.getString("mintAddress")) ||
                !wallet.equals(next.getString("walletAddress")))
            throw new IllegalArgumentException("Silver Points asset changed");
        JSONObject approvedAllocation = next.getJSONObject("allocation");
        String[] names = { "comfort", "charm", "quality", "luck" };
        if (approvedAllocation.length() != 4 || allocation.length() != 4)
            throw new IllegalArgumentException("Silver Points allocation shape changed");
        int spent = 0;
        for (String name : names) {
            int value = approvedAllocation.getInt(name);
            if (value < 0 || value > 114 || allocation.getInt(name) != value)
                throw new IllegalArgumentException("Silver Points allocation changed");
            spent += value;
        }
        if (spent < 1 || spent > next.getInt("unspentPoints") || spent > 114)
            throw new IllegalArgumentException("Silver Points total changed");
        JSONObject terms = refreshed.getJSONObject("terms");
        if (!mint.equals(terms.getString("mintAddress")) ||
                !wallet.equals(terms.getString("walletAddress")) ||
                !allocationEqual(approvedAllocation, terms.getJSONObject("allocation")) ||
                terms.getInt("level") != next.getInt("level") ||
                terms.getInt("pointsBefore") != next.getInt("unspentPoints") ||
                terms.getInt("pointsSpent") != spent ||
                !"0".equals(terms.getString("ertExact")) ||
                !"0".equals(terms.getString("eruExact")))
            throw new IllegalArgumentException("Silver Points review changed");
        byte[] message = Base64.getDecoder().decode(next.getString("messageBase64"));
        if (next.getInt("sizeBytes") != message.length + 65 ||
                next.getInt("sizeBytes") > 1232)
            throw new IllegalArgumentException("Silver Points message size changed");
        Cursor in = new Cursor(message);
        if (in.u8() != 1 || in.u8() != 0 || in.u8() != 3 || in.vec() != 5)
            throw new IllegalArgumentException("Silver Points signer graph changed");
        String[] keys = new String[5];
        Set<String> distinct = new HashSet<>();
        for (int i = 0; i < keys.length; i++) {
            keys[i] = SilverOpeningPolicy.address(in.bytes(32));
            if (!distinct.add(keys[i])) throw new IllegalArgumentException("Duplicate Points account");
        }
        String ring = AssociatedTokenAddress.deriveProgramAddress(PROGRAM,
                "silver-ring-state".getBytes(StandardCharsets.US_ASCII),
                AssociatedTokenAddress.decode(mint));
        String token = next.getString("tokenAddress");
        if (!wallet.equals(keys[0]) || !ring.equals(next.getString("ringAddress")) ||
                !distinct.equals(new HashSet<>(Arrays.asList(wallet, mint, ring, token, PROGRAM))))
            throw new IllegalArgumentException("Silver Points accounts changed");
        in.bytes(32);
        if (in.vec() != 1 || !PROGRAM.equals(keys[in.u8()]) || in.vec() != 4 ||
                !wallet.equals(keys[in.u8()]) || !mint.equals(keys[in.u8()]) ||
                !ring.equals(keys[in.u8()]) || !token.equals(keys[in.u8()]))
            throw new IllegalArgumentException("Silver Points instruction changed");
        byte[] data = in.bytes(in.vec());
        if (!in.done() || data.length != 14 || data[0] != 17 ||
                (data[1] & 255) != next.getInt("level") ||
                u64Point(data, 2) != next.getInt("unspentPoints"))
            throw new IllegalArgumentException("Silver Points state changed");
        org.json.JSONArray values = next.getJSONArray("attributes");
        if (values.length() != 4) throw new IllegalArgumentException("Silver attributes changed");
        for (int i = 0; i < 4; i++)
            if ((data[6 + i] & 255) != values.getInt(i) ||
                    (data[10 + i] & 255) != approvedAllocation.getInt(names[i]))
                throw new IllegalArgumentException("Silver Points allocation changed");
        return message;
    }

    private static boolean allocationEqual(JSONObject left, JSONObject right) throws Exception {
        if (left.length() != 4 || right.length() != 4) return false;
        for (String name : new String[] { "comfort", "charm", "quality", "luck" })
            if (left.getInt(name) != right.getInt(name)) return false;
        return true;
    }

    private static boolean allocationTermsEqual(JSONObject left, JSONObject right) throws Exception {
        if (left.length() != right.length() ||
                !allocationEqual(left.getJSONObject("allocation"), right.getJSONObject("allocation")))
            return false;
        for (String name : new String[] { "mintAddress", "walletAddress", "level",
                "pointsBefore", "pointsSpent", "ertExact", "eruExact" })
            if (!left.get(name).toString().equals(right.get(name).toString())) return false;
        return true;
    }

    static byte[] approvedMessage(JSONObject approved, JSONObject refreshed,
            String mint, int current, String wallet) throws Exception {
        if (current < 1 || current >= 20 ||
                !approved.getJSONObject("terms").toString().equals(
                        refreshed.getJSONObject("terms").toString()))
            throw new IllegalArgumentException("Silver terms changed");
        JSONObject first = approved.getJSONObject("candidate");
        JSONObject next = refreshed.getJSONObject("candidate");
        boolean paid = current == 4 || current == 19;
        for (String name : new String[] { "intentDigest", "operationId", "reservationId",
                "accountId", "walletAddress", "issuerAddress", "mintAddress",
                "tokenAddress", "ringAddress", "currentLevel", "targetLevel", "ertCost",
                "programId", "cluster", "genesisHash" })
            if (!first.get(name).toString().equals(next.get(name).toString()))
                throw new IllegalArgumentException("Silver intent changed: " + name);
        if (paid) for (String name : new String[] { "gatewayProgramId",
                "gatewayConfigBase64", "nonce", "expirySlot", "configEpoch",
                "eruPrincipal", "eruFee" })
            if (!first.get(name).toString().equals(next.get(name).toString()))
                throw new IllegalArgumentException("Silver payment intent changed: " + name);
        if (!PROGRAM.equals(next.getString("programId")) ||
                !"devnet".equals(next.getString("cluster")) ||
                !GENESIS.equals(next.getString("genesisHash")) ||
                !wallet.equals(next.getString("walletAddress")) ||
                !mint.equals(next.getString("mintAddress")) ||
                next.getInt("currentLevel") != current ||
                next.getInt("targetLevel") != current + 1 ||
                !String.valueOf(5 * (current + 2)).equals(next.getString("ertCost")))
            throw new IllegalArgumentException("Silver authority or price changed");
        JSONObject terms = refreshed.getJSONObject("terms");
        if (!mint.equals(terms.getString("mintAddress")) ||
                !wallet.equals(terms.getString("walletAddress")) ||
                !next.getString("operationId").equals(terms.getString("operationId")) ||
                !next.getString("reservationId").equals(terms.getString("reservationId")) ||
                terms.getInt("currentLevel") != current ||
                terms.getInt("targetLevel") != current + 1 ||
                terms.getInt("pointsGranted") != 6 ||
                !next.getString("ertCost").equals(terms.getString("ertExact")) ||
                !(paid ? (current == 4 ? "38.76" : "76.50") : "0")
                        .equals(terms.getString("eruExact")))
            throw new IllegalArgumentException("Silver review does not match payment");
        byte[] message = Base64.getDecoder().decode(next.getString("messageBase64"));
        if (next.getInt("sizeBytes") != message.length + 129 ||
                next.getInt("sizeBytes") > 1232) throw new IllegalArgumentException("Silver size invalid");
        Cursor in = new Cursor(message);
        int signers = in.u8(), signedReadonly = in.u8(), unsignedReadonly = in.u8();
        if (signers != 2 || signedReadonly != 1 ||
                unsignedReadonly != (paid ? 12 : 6) || in.vec() != (paid ? 22 : 10))
            throw new IllegalArgumentException("Silver signer/account graph changed");
        String[] keys = new String[paid ? 22 : 10];
        Set<String> distinct = new HashSet<>();
        for (int i = 0; i < keys.length; i++) {
            keys[i] = SilverOpeningPolicy.address(in.bytes(32));
            if (!distinct.add(keys[i])) throw new IllegalArgumentException("Duplicate Silver account");
        }
        String issuer = next.getString("issuerAddress");
        String token = next.getString("tokenAddress");
        String ring = AssociatedTokenAddress.deriveProgramAddress(PROGRAM,
                "silver-ring-state".getBytes(StandardCharsets.US_ASCII),
                AssociatedTokenAddress.decode(mint));
        String replay = AssociatedTokenAddress.deriveProgramAddress(PROGRAM,
                "silver-progress".getBytes(StandardCharsets.US_ASCII),
                AssociatedTokenAddress.decode(mint), uuid(next.getString("operationId")));
        String config = AssociatedTokenAddress.deriveProgramAddress(PROGRAM,
                "silver-config".getBytes(StandardCharsets.US_ASCII));
        if (!wallet.equals(keys[0]) || !issuer.equals(keys[1]) ||
                !ring.equals(next.getString("ringAddress")) ||
                (!paid && !distinct.equals(new HashSet<>(Arrays.asList(wallet, issuer, ring, replay,
                        config, mint, token, SYSTEM, PROGRAM, COMPUTE)))))
            throw new IllegalArgumentException("Silver accounts changed");
        in.bytes(32); // refreshed blockhash; economic intent was compared above
        if (in.vec() != 2) throw new IllegalArgumentException("Silver instructions changed");
        if (!COMPUTE.equals(keys[in.u8()]) || in.vec() != 0 ||
                !Arrays.equals(in.bytes(in.vec()), paid ?
                        new byte[] { 2, 0, 0x35, 0x0c, 0 } :
                        new byte[] { 2, (byte) 0xe0, (byte) 0x93, 4, 0 }))
            throw new IllegalArgumentException("Silver compute instruction changed");
        if (!PROGRAM.equals(keys[in.u8()]) || in.vec() != (paid ? 20 : 8))
            throw new IllegalArgumentException("Silver program instruction changed");
        String[] expected = { wallet, issuer, config, mint, ring, token, replay, SYSTEM };
        for (String value : expected)
            if (!value.equals(keys[in.u8()]))
                throw new IllegalArgumentException("Silver instruction account changed");
        if (paid) {
            byte[] gatewayConfig = Base64.getDecoder().decode(next.getString("gatewayConfigBase64"));
            if (gatewayConfig.length != 330 || gatewayConfig[0] != 1 ||
                    gatewayConfig[169] != 0 || u64(gatewayConfig, 322) != 1 ||
                    !ERU_MINT.equals(SilverOpeningPolicy.address(
                            Arrays.copyOfRange(gatewayConfig, 33, 65))) ||
                    !ERU_TREASURY.equals(SilverOpeningPolicy.address(
                            Arrays.copyOfRange(gatewayConfig, 65, 97))) ||
                    !ERU_HOOK.equals(SilverOpeningPolicy.address(
                            Arrays.copyOfRange(gatewayConfig, 97, 129))) ||
                    !GATEWAY.equals(next.getString("gatewayProgramId")) ||
                    !"1".equals(next.getString("configEpoch")) ||
                    !(current == 4 ? "38" : "75").equals(next.getString("eruPrincipal")) ||
                    !(current == 4 ? "0.76" : "1.50").equals(next.getString("eruFee")))
                throw new IllegalArgumentException("Silver Gateway config or cost changed");
            String gatewayConfigPda = AssociatedTokenAddress.deriveProgramAddress(GATEWAY,
                    "eru-config".getBytes(StandardCharsets.US_ASCII));
            String[] payment = { GATEWAY, gatewayConfigPda,
                    AssociatedTokenAddress.derive(wallet, TOKEN_2022, ERU_MINT),
                    ERU_MINT, ERU_TREASURY,
                    AssociatedTokenAddress.deriveProgramAddress(ERU_HOOK,
                            "extra-account-metas".getBytes(StandardCharsets.US_ASCII),
                            AssociatedTokenAddress.decode(ERU_MINT)),
                    INSTRUCTIONS, TOKEN_2022, ERU_HOOK,
                    AssociatedTokenAddress.deriveProgramAddress(GATEWAY,
                            "nonce".getBytes(StandardCharsets.US_ASCII),
                            AssociatedTokenAddress.decode(gatewayConfigPda),
                            AssociatedTokenAddress.decode(wallet)),
                    AssociatedTokenAddress.deriveProgramAddress(GATEWAY,
                            "silver-level-up".getBytes(StandardCharsets.US_ASCII),
                            AssociatedTokenAddress.decode(gatewayConfigPda),
                            AssociatedTokenAddress.decode(wallet),
                            uuid(next.getString("operationId"))),
                    AssociatedTokenAddress.deriveProgramAddress(PROGRAM,
                            "silver-paid-gateway".getBytes(StandardCharsets.US_ASCII)) };
            for (String value : payment)
                if (!value.equals(keys[in.u8()]))
                    throw new IllegalArgumentException("Silver Gateway account changed");
        }
        byte[] data = in.bytes(in.vec());
        if (!in.done() || data.length != (paid ? 83 : 59) ||
                data[0] != (paid ? 18 : 16) ||
                (data[1] & 255) != current || (data[2] & 255) != current + 1 ||
                !Arrays.equals(uuid(next.getString("operationId")),
                        Arrays.copyOfRange(data, 3, 19)) ||
                !Arrays.equals(uuid(next.getString("reservationId")),
                        Arrays.copyOfRange(data, 19, 35)) ||
                !Arrays.equals(uuid(next.getString("accountId")),
                        Arrays.copyOfRange(data, 35, 51)) ||
                u64(data, 51) != 5L * (current + 2) ||
                (paid && (u64(data, 59) != next.getLong("nonce") ||
                        u64(data, 67) != next.getLong("expirySlot") ||
                        u64(data, 75) != 1)))
            throw new IllegalArgumentException("Silver transaction differs from reviewed payment");
        return message;
    }

    private static byte[] uuid(String value) {
        UUID.fromString(value);
        String hex = value.replace("-", "");
        byte[] bytes = new byte[16];
        for (int i = 0; i < 16; i++) bytes[i] =
                (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }

    private static long u64(byte[] bytes, int offset) {
        long value = 0;
        for (int i = 7; i >= 0; i--) value = (value << 8) | (bytes[offset + i] & 255L);
        return value;
    }

    private static long u64Point(byte[] bytes, int offset) {
        long result = 0;
        for (int i = 3; i >= 0; i--) result = (result << 8) | (bytes[offset + i] & 255L);
        return result;
    }

    private static final class Cursor {
        private final byte[] data;
        private int offset;
        Cursor(byte[] data) { this.data = data; }
        int u8() { if (offset >= data.length) throw new IllegalArgumentException("Truncated Silver message");
            return data[offset++] & 255; }
        int vec() { int value = 0;
            for (int i = 0; i < 3; i++) { int part = u8(); value |= (part & 127) << (7 * i);
                if ((part & 128) == 0) return value; }
            throw new IllegalArgumentException("Invalid Silver vector"); }
        byte[] bytes(int count) { if (count < 0 || count > data.length - offset)
            throw new IllegalArgumentException("Truncated Silver field");
            byte[] result = Arrays.copyOfRange(data, offset, offset + count);
            offset += count; return result; }
        boolean done() { return offset == data.length; }
    }
}
