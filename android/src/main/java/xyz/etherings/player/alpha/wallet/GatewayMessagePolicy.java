package xyz.etherings.player.alpha.wallet;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

final class GatewayMessagePolicy {
    private static final String ALPHABET =
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static final String COMPUTE_BUDGET =
            "ComputeBudget111111111111111111111111111111";
    private final GatewayTransferIntent intent;

    GatewayMessagePolicy(GatewayTransferIntent intent) {
        this.intent = intent;
    }

    String authority() throws Exception {
        return value("authority");
    }

    void validate(byte[] message) throws Exception {
        Cursor input = new Cursor(message);
        int requiredSignatures = input.u8();
        int readonlySigned = input.u8();
        int readonlyUnsigned = input.u8();
        require(requiredSignatures == 1 && readonlySigned == 0,
                "unexpected signer header or message version");
        int count = input.shortVec();
        require(count == 14 && readonlyUnsigned <= count - 1, "unexpected account count");
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
        require(input.shortVec() == 2, "additional or missing instruction");

        int computeProgramIndex = input.u8();
        require(key(keys, computeProgramIndex).equals(COMPUTE_BUDGET), "unknown first program");
        require(input.shortVec() == 0, "compute instruction account mismatch");
        byte[] computeData = input.bytes(input.shortVec());
        require(computeData.length == 5 && (computeData[0] & 255) == 2
                && uint32(computeData, 1) == 600_000L, "compute limit mismatch");

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
        require(amount == intent.amount && nonce == intent.nonce && expiry == intent.expiry,
                "Gateway amount/nonce/expiry mismatch");
    }

    private String value(String field) {
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
