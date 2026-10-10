package xyz.etherings.player.alpha.wallet;

import org.json.JSONObject;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public final class GatewayMessagePolicy {
    private static final String ALPHABET =
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static final String COMPUTE_BUDGET =
            "ComputeBudget111111111111111111111111111111";
    private static final long DEVNET_AMOUNT = 30_000_000_000L;
    private final GatewayTransferIntent intent;
    private final JSONObject policy;
    private final String requestedRecipient;
    private final String requestedDestination;
    private final long requestedAmount;

    GatewayMessagePolicy(GatewayTransferIntent intent) {
        this.intent = intent;
        this.policy = null;
        this.requestedRecipient = null;
        this.requestedDestination = null;
        this.requestedAmount = 0;
    }

    GatewayMessagePolicy(GatewayTransferIntent intent, String recipient) {
        this.intent = intent;
        this.policy = null;
        this.requestedRecipient = recipient;
        this.requestedDestination = AssociatedTokenAddress.derive(recipient,
                intent.tokenProgram, intent.mint);
        if (!requestedDestination.equals(intent.destination))
            throw new IllegalArgumentException("Recipient and signed destination differ");
        this.requestedAmount = intent.amount;
    }

    public GatewayMessagePolicy(JSONObject policy) throws Exception {
        if (!"devnet".equals(policy.getString("cluster")))
            throw new IllegalArgumentException("Unexpected ERU cluster");
        this.policy = policy;
        this.intent = null;
        this.requestedRecipient = null;
        this.requestedDestination = null;
        this.requestedAmount = 0;
    }

    public GatewayMessagePolicy(JSONObject policy, String recipient, long amount) throws Exception {
        if (!"devnet".equals(policy.getString("cluster")) || amount <= 0 ||
                recipient.equals(policy.getString("authority")))
            throw new IllegalArgumentException("Invalid ERU send request");
        EruSendAmount.fee(amount);
        this.policy = policy;
        this.intent = null;
        this.requestedRecipient = recipient;
        this.requestedDestination = AssociatedTokenAddress.derive(recipient,
                policy.getString("tokenProgram"), policy.getString("mint"));
        if (requestedDestination.equals(policy.getString("source")) ||
                requestedDestination.equals(policy.getString("treasury")))
            throw new IllegalArgumentException("Invalid recipient token account");
        this.requestedAmount = amount;
    }

    public String authority() throws Exception {
        return value("authority");
    }

    public Decoded validate(byte[] message) throws Exception {
        return validate(message, -1);
    }

    public Decoded validate(byte[] message, long confirmedSlot) throws Exception {
        Cursor input = new Cursor(message);
        int requiredSignatures = input.u8();
        int readonlySigned = input.u8();
        int readonlyUnsigned = input.u8();
        require(requiredSignatures == 1 && readonlySigned == 0,
                "unexpected signer header or message version");
        int count = input.shortVec();
        require(count >= 14 && count <= 16 && readonlyUnsigned <= count - 1,
                "unexpected account count");
        String[] keys = new String[count];
        Set<String> actual = new HashSet<>();
        for (int i = 0; i < count; i++) {
            keys[i] = base58(input.bytes(32));
            require(actual.add(keys[i]), "duplicate account key");
        }
        String[] expectedFields = {
                "authority", "source", "destination", "treasury", "config", "replay",
                "mint", "meta", "sysvar", "tokenProgram", "hook", "systemProgram", "gateway"
        };
        Set<String> expected = new HashSet<>();
        for (String field : expectedFields) expected.add(value(field));
        expected.add(COMPUTE_BUDGET);
        if (requestedRecipient != null) {
            expected.add(requestedRecipient);
            expected.add(AssociatedTokenAddress.PROGRAM);
        }
        require(count == expected.size(), "unexpected account count");
        require(actual.equals(expected), "unknown/missing account, mint or program");
        require(keys[0].equals(authority()), "fee payer is not selected wallet");
        Set<String> writable = new HashSet<>(Arrays.asList(
                authority(), value("source"), value("destination"),
                value("treasury"), value("config"),
                value("replay")));
        for (int i = 0; i < count; i++) {
            boolean signer = i < requiredSignatures;
            boolean write = signer ? i < requiredSignatures - readonlySigned
                    : i < count - readonlyUnsigned;
            require(signer == keys[i].equals(authority()), "unexpected signer");
            require(write == writable.contains(keys[i]), "unexpected writable account");
        }
        byte[] blockhash = input.bytes(32);
        require(!Arrays.equals(blockhash, new byte[32]), "empty blockhash");
        require(input.shortVec() == (requestedRecipient == null ? 2 : 3),
                "additional or missing instruction");

        int computeProgramIndex = input.u8();
        require(key(keys, computeProgramIndex).equals(COMPUTE_BUDGET), "unknown first program");
        require(input.shortVec() == 0, "compute instruction account mismatch");
        byte[] computeData = input.bytes(input.shortVec());
        require(computeData.length == 5 && (computeData[0] & 255) == 2
                && uint32(computeData, 1) == 600_000L, "compute limit mismatch");

        if (requestedRecipient != null) {
            require(key(keys, input.u8()).equals(AssociatedTokenAddress.PROGRAM),
                    "unknown ATA program");
            String[] ataOrder = { "authority", "destination", "recipient", "mint",
                    "systemProgram", "tokenProgram" };
            require(input.shortVec() == ataOrder.length, "ATA account count mismatch");
            for (String field : ataOrder) {
                String expectedAccount = field.equals("recipient") ? requestedRecipient : value(field);
                require(key(keys, input.u8()).equals(expectedAccount), "ATA account mismatch: " + field);
            }
            byte[] ataData = input.bytes(input.shortVec());
            require(ataData.length == 1 && ataData[0] == 1, "ATA instruction mismatch");
        }

        int gatewayProgramIndex = input.u8();
        require(key(keys, gatewayProgramIndex).equals(value("gateway")),
                "unknown Gateway program");
        String[] ordered = {
                "source", "mint", "destination", "treasury", "authority", "config",
                "meta", "sysvar", "tokenProgram", "hook", "replay", "authority",
                "systemProgram"
        };
        require(input.shortVec() == ordered.length, "Gateway account count mismatch");
        for (String field : ordered) {
            require(key(keys, input.u8()).equals(value(field)),
                    "Gateway account order/identity mismatch: " + field);
        }
        byte[] data = input.bytes(input.shortVec());
        require(data.length == 25 && (data[0] & 255) == 1, "Gateway data/tag mismatch");
        long amount = uint64(data, 1);
        long nonce = uint64(data, 9);
        long expiry = uint64(data, 17);
        require(input.atEnd(), "trailing transaction bytes");
        if (intent != null) {
            require(amount == intent.amount && nonce == intent.nonce && expiry == intent.expiry,
                    "Gateway amount/nonce/expiry mismatch");
            if (confirmedSlot >= 0)
                require(expiry >= confirmedSlot, "ERU intent expired before signing");
        } else {
            require(amount == (requestedRecipient == null ? DEVNET_AMOUNT : requestedAmount) &&
                    nonce > 0, "Gateway amount/nonce mismatch");
            require(confirmedSlot >= 0 && expiry >= confirmedSlot &&
                    expiry - confirmedSlot <= 600, "ERU intent expired or outside Devnet window");
        }
        long fee = EruSendAmount.fee(amount);
        return new Decoded(amount, fee, nonce, expiry, value("destination"),
                value("treasury"), base58(blockhash), message,
                new GatewayTransferIntent(authority(), value("source"), value("destination"),
                        value("treasury"), value("config"), value("replay"), value("mint"),
                        value("meta"), value("sysvar"), value("tokenProgram"), value("hook"),
                        value("systemProgram"), value("gateway"), amount, nonce, expiry));
    }

    private String value(String field) {
        if (field.equals("destination") && requestedDestination != null)
            return requestedDestination;
        if (policy != null) {
            try { return policy.getString(field); }
            catch (Exception error) { throw new IllegalArgumentException("Missing ERU policy field", error); }
        }
        switch (field) {
            case "authority": return intent.authority;
            case "source": return intent.source;
            case "destination": return intent.destination;
            case "treasury": return intent.treasury;
            case "config": return intent.config;
            case "replay": return intent.replay;
            case "mint": return intent.mint;
            case "meta": return intent.meta;
            case "sysvar": return intent.sysvar;
            case "tokenProgram": return intent.tokenProgram;
            case "hook": return intent.hook;
            case "systemProgram": return intent.systemProgram;
            case "gateway": return intent.gateway;
            default: throw new IllegalArgumentException("unknown account role");
        }
    }

    public static final class Decoded {
        public final long amountBaseUnits;
        public final long feeBaseUnits;
        public final long nonce;
        public final long expirySlot;
        public final String destination;
        public final String treasury;
        public final String blockhash;
        private final byte[] message;
        private final GatewayTransferIntent intent;

        private Decoded(long amount, long fee, long nonce, long expiry, String destination,
                String treasury, String blockhash, byte[] message, GatewayTransferIntent intent) {
            amountBaseUnits = amount;
            feeBaseUnits = fee;
            this.nonce = nonce;
            expirySlot = expiry;
            this.destination = destination;
            this.treasury = treasury;
            this.blockhash = blockhash;
            this.message = Arrays.copyOf(message, message.length);
            this.intent = intent;
        }

        public byte[] message() { return Arrays.copyOf(message, message.length); }
        public GatewayTransferIntent intent() { return intent; }
    }

    private static String key(String[] keys, int index) {
        if (index < 0 || index >= keys.length) throw new IllegalArgumentException("bad account index");
        return keys[index];
    }

    private static void require(boolean condition, String reason) {
        if (!condition) throw new IllegalArgumentException(reason);
    }

    private static long uint32(byte[] bytes, int offset) {
        long value = 0;
        for (int i = 0; i < 4; i++) value |= (bytes[offset + i] & 255L) << (8 * i);
        return value;
    }

    private static long uint64(byte[] bytes, int offset) {
        long value = 0;
        for (int i = 0; i < 8; i++) value |= (bytes[offset + i] & 255L) << (8 * i);
        require(value >= 0, "u64 outside proof domain");
        return value;
    }

    private static String base58(byte[] bytes) {
        int leading = 0;
        while (leading < bytes.length && bytes[leading] == 0) leading++;
        BigInteger number = new BigInteger(1, bytes);
        StringBuilder text = new StringBuilder();
        while (number.signum() > 0) {
            BigInteger[] divided = number.divideAndRemainder(BigInteger.valueOf(58));
            text.append(ALPHABET.charAt(divided[1].intValue()));
            number = divided[0];
        }
        for (int i = 0; i < leading; i++) text.append('1');
        return text.reverse().toString();
    }

    private static final class Cursor {
        final byte[] input;
        int position;

        Cursor(byte[] input) { this.input = input; }

        int u8() {
            require(position < input.length, "truncated message");
            return input[position++] & 255;
        }

        int shortVec() {
            int value = 0;
            for (int i = 0; i < 3; i++) {
                int part = u8();
                value |= (part & 127) << (7 * i);
                if ((part & 128) == 0) {
                    require(value <= 256, "oversized vector");
                    return value;
                }
            }
            throw new IllegalArgumentException("invalid vector length");
        }

        byte[] bytes(int count) {
            require(count >= 0 && count <= input.length - position, "truncated field");
            byte[] result = Arrays.copyOfRange(input, position, position + count);
            position += count;
            return result;
        }

        boolean atEnd() { return position == input.length; }
    }
}
