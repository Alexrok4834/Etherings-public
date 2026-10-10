package xyz.etherings.alpha;

import org.json.JSONObject;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

final class SilverTransferPolicy {
    private static final String ALPHABET =
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private final JSONObject policy;

    SilverTransferPolicy(JSONObject policy) { this.policy = policy; }

    String authority() throws Exception { return policy.getString("authority"); }

    Decoded validate(byte[] message) throws Exception {
        Cursor input = new Cursor(message);
        int signers = input.u8();
        int readonlySigned = input.u8();
        int readonlyUnsigned = input.u8();
        require(signers == 1 && readonlySigned == 0, "unexpected signer header or version");
        int count = input.shortVec();
        require(count == 8 && readonlyUnsigned == 4, "unexpected account count or flags");
        String[] keys = new String[count];
        Set<String> actual = new HashSet<>();
        for (int i = 0; i < count; i++) {
            keys[i] = base58(input.bytes(32));
            require(actual.add(keys[i]), "duplicate account key");
        }
        String[] names = { "authority", "source", "destination", "state", "mint",
                "meta", "hook", "tokenProgram" };
        Set<String> expected = new HashSet<>();
        for (String name : names) expected.add(policy.getString(name));
        require(expected.size() == count && actual.equals(expected),
                "unexpected program, mint or account");
        require(keys[0].equals(authority()), "fee payer is not bound wallet");
        require(!policy.getString("source").equals(policy.getString("destination")),
                "destination is source");
        Set<String> writable = new HashSet<>(Arrays.asList(authority(),
                policy.getString("source"), policy.getString("destination"),
                policy.getString("state")));
        for (int i = 0; i < count; i++) {
            boolean signer = i < signers;
            boolean write = signer ? i < signers - readonlySigned
                    : i < count - readonlyUnsigned;
            require(signer == keys[i].equals(authority()), "unexpected signer");
            require(write == writable.contains(keys[i]), "unexpected writable account");
        }
        byte[] blockhash = input.bytes(32);
        require(!Arrays.equals(blockhash, new byte[32]), "empty blockhash");
        require(input.shortVec() == 1, "additional or missing instruction");
        require(key(keys, input.u8()).equals(policy.getString("tokenProgram")),
                "unexpected instruction program");
        String[] ordered = { "source", "mint", "destination", "authority", "meta",
                "state", "hook" };
        require(input.shortVec() == ordered.length, "transfer account count mismatch");
        for (String name : ordered)
            require(key(keys, input.u8()).equals(policy.getString(name)),
                    "transfer account mismatch: " + name);
        byte[] data = input.bytes(input.shortVec());
        require(data.length == 10 && (data[0] & 255) == 12 && data[9] == 0,
                "not a zero-decimal TransferChecked");
        long amount = 0;
        for (int i = 0; i < 8; i++) amount |= (data[1 + i] & 255L) << (8 * i);
        require(amount == 1 && "1".equals(policy.getString("amount")),
                "Silver amount mismatch");
        require(input.atEnd(), "trailing message bytes");
        require("devnet".equals(policy.getString("cluster")), "wrong cluster");
        return new Decoded(message, policy.getString("destination"), base58(blockhash));
    }

    static final class Decoded {
        final String destination;
        final String blockhash;
        private final byte[] message;

        Decoded(byte[] message, String destination, String blockhash) {
            this.message = Arrays.copyOf(message, message.length);
            this.destination = destination;
            this.blockhash = blockhash;
        }

        byte[] message() { return Arrays.copyOf(message, message.length); }
    }

    private static String key(String[] keys, int index) {
        require(index >= 0 && index < keys.length, "invalid account index");
        return keys[index];
    }

    private static void require(boolean okay, String message) {
        if (!okay) throw new IllegalArgumentException(message);
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
                value |= (part & 127) << (7 * i);
                if ((part & 128) == 0) {
                    require(value <= 256, "oversized vector");
                    return value;
                }
            }
            throw new IllegalArgumentException("invalid vector length");
        }

        byte[] bytes(int count) {
            require(count >= 0 && count <= bytes.length - position, "truncated field");
            byte[] result = Arrays.copyOfRange(bytes, position, position + count);
            position += count;
            return result;
        }

        boolean atEnd() { return position == bytes.length; }
    }
}
