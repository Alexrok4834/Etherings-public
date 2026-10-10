package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.Base64;

@RunWith(AndroidJUnit4.class)
public final class DevnetIntentMutationTest {
    // Public, unsigned message from the already confirmed Step 3 Devnet intent.
    private static final String MESSAGE = "AQAIDhKwXB6kHdafseJ+XK8BGSsURGmC7q4dvJ8uGVyrbYuPT6KIqC03DhFNrxjfRVnkjL+f/9vgc4ZvHDWzTt6x0yN4jSf9eAj4jDVJyRcsNCJ5ScFyU8BrpQKMt0Ld4c0EpY3ZDXlm/XqpooEKe1fL6PBA7KianZV0h5jWQcgHUgoiyoNEZa83lugSKyZgdP4+Tek1vVSOE9jLqjd7WHrG2SHU+ZnGuH2IvKR6almMwWr9egZIw7V2PR6i1CdawBytNwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGKj2Rzl0KZODOnJd+mXu8xOpNioAmNwmr4xMaaCZ/Scw5L2yf6KQycD96V6HQWYKHvrQEeumUvApxNUw+D6RXWfc4taE73f27Wm2jdmR8R+6z9miuiTnM/Q2mm4IaKJHaAwcioUiDEUIEcBs2C2Q3vHva8ijsLxFgMp3N2lWSAMDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAAan1RcYe9FmNdrUBFX9wsDBJMaPIVZ1pdu6y18IAAAABt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wNK8HDe59UzF4uCgFu4gG8MUcgBx4zNsu5UUynDo9YWAILAAUCwCcJAAoNAwkEAQACBwwNCAUABhkBAKwj/AYAAAABAAAAAAAAAL1d2h0AAAAA";
    private static final long HISTORICAL_CONFIRMED_SLOT = 500_849_618L;
    private static final String POLICY = "{" +
            "\"cluster\":\"devnet\"," +
            "\"authority\":\"2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc\"," +
            "\"source\":\"AYiSyWmb8MFcDLgPfoQhFXw7L2H4xUFMckHwetWnsXbw\"," +
            "\"destination\":\"EdXT16XWGS5vf1X2ezwaL5TB6ZLb5XqsMxBF439FmHmi\"," +
            "\"treasury\":\"6MrxKmPBSC8edNv7WfPb1JekAv9pDhEVs1uQt6H9uCn6\"," +
            "\"config\":\"97amFjWUMqwMFY5PVgcWYaTnQQaD4NTayFXvP3ipGDRW\"," +
            "\"replay\":\"FLNBSetSvoD7CfJEvpMqK8ZQpEWA1HJbk8vF5mSnQmcJ\"," +
            "\"mint\":\"7zSM3kBiPCVJCmvYYK8quXeydLTWtMNQDwPm3weQTHNe\"," +
            "\"meta\":\"2fGDWLUxokVrv6hWWJYH9kYfhrFfrn7GKqpEEAfByKtr\"," +
            "\"sysvar\":\"Sysvar1nstructions1111111111111111111111111\"," +
            "\"tokenProgram\":\"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb\"," +
            "\"hook\":\"4HrsQyjt5StEJkhcqeWTLHvYCtDWVrBoeqEcnK5f8pHi\"," +
            "\"systemProgram\":\"11111111111111111111111111111111\"," +
            "\"gateway\":\"81A7VsEBQpKgAagZrHnjE2ntK12poaiVth4i3wQ5thi2\"}";

    private GatewayMessagePolicy verifier() throws Exception {
        return new GatewayMessagePolicy(new JSONObject(POLICY));
    }

    private byte[] original() {
        return Base64.getDecoder().decode(MESSAGE);
    }

    private void rejected(byte[] message, String reason) throws Exception {
        assertEquals(reason, assertThrows(IllegalArgumentException.class,
                () -> verifier().validate(message, HISTORICAL_CONFIRMED_SLOT)).getMessage());
    }

    @Test public void baselineIsTheAcceptedHistoricalMessage() throws Exception {
        assertEquals(30_000_000_000L,
                verifier().validate(original(), HISTORICAL_CONFIRMED_SLOT).amountBaseUnits);
    }

    @Test public void alteredAmountRejectedBeforeSigning() throws Exception {
        byte[] message = original();
        byte[] amount = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
                .putLong(30_000_000_000L).array();
        int offset = findUnique(message, amount, 0, message.length);
        message[offset] ^= 1;
        rejected(message, "Gateway amount/nonce mismatch");
    }

    @Test public void alteredRecipientRejectedBeforeSigning() throws Exception {
        alteredAccount("destination");
    }

    @Test public void alteredTreasuryRejectedBeforeSigning() throws Exception {
        alteredAccount("treasury");
    }

    @Test public void alteredMintRejectedBeforeSigning() throws Exception {
        alteredAccount("mint");
    }

    @Test public void alteredClusterRejectedBeforeSigning() {
        assertEquals("ERU intent cluster mismatch", assertThrows(IllegalArgumentException.class,
                () -> IntentExpiry.requireCluster("devnet", "local-validator")).getMessage());
    }

    private void alteredAccount(String field) throws Exception {
        byte[] message = original();
        byte[] key = decodeBase58(new JSONObject(POLICY).getString(field));
        int offset = findUnique(message, key, 4, 4 + 14 * 32);
        message[offset] ^= 1;
        rejected(message, "unknown/missing account, mint or program");
    }

    private static int findUnique(byte[] haystack, byte[] needle, int start, int end) {
        int found = -1;
        for (int i = start; i <= end - needle.length; i++) {
            if (Arrays.equals(Arrays.copyOfRange(haystack, i, i + needle.length), needle)) {
                assertEquals("fixture mutation target must be unique", -1, found);
                found = i;
            }
        }
        assertTrue("fixture mutation target missing", found >= 0);
        return found;
    }

    private static byte[] decodeBase58(String address) {
        String alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        BigInteger value = BigInteger.ZERO;
        for (char digit : address.toCharArray()) {
            int index = alphabet.indexOf(digit);
            assertTrue("invalid base58 address", index >= 0);
            value = value.multiply(BigInteger.valueOf(58)).add(BigInteger.valueOf(index));
        }
        byte[] encoded = value.toByteArray();
        byte[] result = new byte[32];
        int count = Math.min(encoded.length, 32);
        System.arraycopy(encoded, encoded.length - count, result, 32 - count, count);
        return result;
    }
}
