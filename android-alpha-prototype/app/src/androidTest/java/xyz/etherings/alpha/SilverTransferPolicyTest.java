package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Base64;

@RunWith(AndroidJUnit4.class)
public final class SilverTransferPolicyTest {
    // Unsigned test-only message for the migrated Devnet Box; no wallet material.
    private static final String MESSAGE =
            "AQAECBKwXB6kHdafseJ+XK8BGSsURGmC7q4dvJ8uGVyrbYuPs+cIiaIcKK7H72lLx3YXDD+KMqwcRncHWTwkzDucHhg6LpE08yhwG0g5q7R9/VxzLxasTmfL8kyr1tIe89rCgIqt0pT3ec2ZUpsjtnXlUrIDlx/wD9foG6nU3wOt+OzZBt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wbxA5dg9yJGDMy8K00+c3FoIUYS3g5CzErYGggQMapDJo4uL6E9/zN7h/CKwQpK1W9OaGQ+51XyiTx6vKZiMsJKszfM2f1xpZpMQ57Y/N0NoG95YmgLEPLFp+//b+9gSpYM5IUUyWpz80IJi5F2z8iI1rA+TceSJaCkv6vAG3k2AEEBwEFAgAGAwcKDAEAAAAAAAAAAA==";
    private static final String OWNER = "2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc";
    private static final String SOURCE = "D7GJguPdDt3v8XzsMvQv2Sso22k32no5DQvmdR29eAby";
    private static final String DESTINATION = "4v7qBePEhVhEeug13cgkbvDdJ16e2s87pndMrR7FyV43";
    private static final String MINT = "2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq";
    private static final String STATE = "ALLzXe8f3iTMiWGa3q2LBZAtV5NFQ3rDKYqfkTaV3wGk";
    private static final String META = "BP1x84piw5B2MZgUaSVQkD4hmPK64jWwQKub6mWJtuYC";
    private static final String HOOK = "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX";
    private static final String TOKEN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

    private JSONObject policy() throws Exception {
        return new JSONObject().put("cluster", "devnet").put("authority", OWNER)
                .put("source", SOURCE).put("destination", DESTINATION).put("mint", MINT)
                .put("state", STATE).put("meta", META).put("hook", HOOK)
                .put("tokenProgram", TOKEN).put("amount", "1");
    }

    private byte[] original() { return Base64.getDecoder().decode(MESSAGE); }

    private void rejects(byte[] bytes) throws Exception {
        assertThrows(IllegalArgumentException.class,
                () -> new SilverTransferPolicy(policy()).validate(bytes));
    }

    @Test public void exactTransferAccepted() throws Exception {
        SilverTransferPolicy.Decoded accepted = new SilverTransferPolicy(policy()).validate(original());
        assertEquals(DESTINATION, accepted.destination);
        assertEquals(MESSAGE, Base64.getEncoder().encodeToString(accepted.message()));
    }

    @Test public void changedAccountAndMintRejected() throws Exception {
        for (String address : new String[] { DESTINATION, MINT, META, STATE, HOOK }) {
            byte[] message = original();
            byte[] target = decode58(address);
            int offset = -1;
            for (int i = 4; i <= 4 + 8 * 32 - target.length; i++) {
                if (Arrays.equals(Arrays.copyOfRange(message, i, i + target.length), target)) {
                    assertEquals(-1, offset);
                    offset = i;
                }
            }
            if (offset < 0) throw new AssertionError("fixture account absent");
            message[offset] ^= 1;
            rejects(message);
        }
    }

    @Test public void extraSignerWritableAndInstructionRejected() throws Exception {
        byte[] extraSigner = original();
        extraSigner[0] = 2;
        rejects(extraSigner);
        byte[] extraWritable = original();
        extraWritable[2] = 5;
        rejects(extraWritable);
        byte[] extraInstruction = original();
        extraInstruction[292] = 2;
        rejects(extraInstruction);
    }

    @Test public void changedAmountAndClusterRejected() throws Exception {
        byte[] amount = original();
        amount[amount.length - 2] ^= 1;
        rejects(amount);
        JSONObject wrongCluster = policy().put("cluster", "local-validator");
        assertThrows(IllegalArgumentException.class,
                () -> new SilverTransferPolicy(wrongCluster).validate(original()));
    }

    private static byte[] decode58(String text) {
        String alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        BigInteger number = BigInteger.ZERO;
        for (char digit : text.toCharArray())
            number = number.multiply(BigInteger.valueOf(58))
                    .add(BigInteger.valueOf(alphabet.indexOf(digit)));
        byte[] encoded = number.toByteArray();
        byte[] result = new byte[32];
        System.arraycopy(encoded, encoded.length - 32, result, 0, 32);
        return result;
    }
}
