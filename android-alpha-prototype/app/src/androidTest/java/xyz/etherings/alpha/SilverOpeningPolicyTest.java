package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.Base64;

@RunWith(AndroidJUnit4.class)
public final class SilverOpeningPolicyTest {
    private static final String ALPHABET =
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static final String[] FIELDS = { "authority", "source", "escrow", "state",
            "lifecycle", "operation", "network", "treasury", "request", "mint",
            "extra", "config", "design", "collection", "orao", "token",
            "instructions", "system", "silver", "compute" };
    private static final int[] OPEN = { 0, 9, 1, 2, 3, 4, 10, 5, 11, 12, 13, 6,
            7, 8, 14, 15, 16, 17 };
    private static final int[] TRANSFER = { 1, 9, 2, 0, 10, 3, 4, 18 };

    @Test public void walletCoreSignsOnlyExactLocalCandidateGraph() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AlphaWallet wallet = new AlphaWallet(context);
        assertTrue("physical bound wallet must exist", wallet.exists());
        String authority = wallet.address();
        Vector v = vector(authority);
        SilverOpeningPolicy policy = new SilverOpeningPolicy(v.policy);
        SilverOpeningPolicy.Decoded decoded = policy.validate(v.message);
        assertEquals(authority, decoded.authority);
        assertEquals(v.policy.getString("mint"), decoded.mint);
        assertEquals(v.policy.getString("escrow"), decoded.escrow);
        assertEquals(64, wallet.signSilverOpening(response(v, v.message), policy, authority).length);

        reject(wallet, policy, authority, response(v, changed(v.message, v.prepareProgram, 15)));
        reject(wallet, policy, authority, response(v, changed(v.message, v.transferEscrowIndex, 1)));
        reject(wallet, policy, authority, response(v, changed(v.message, v.transferAmount, 2)));
        reject(wallet, policy, authority, response(v, changed(v.message, v.commitSeed, 4)));
        reject(wallet, policy, authority, response(v, changed(v.message, v.instructionCount, 5)));
        reject(wallet, policy, authority, response(v, changed(v.message, 2, 10)));
        reject(wallet, policy, authority, response(v, changed(v.message, v.mintKey, 7)));
        reject(wallet, policy, authority, response(v, changed(v.message, v.treasuryKey, 8)));
        try {
            wallet.signSilverOpening(response(v, v.message), policy, v.policy.getString("source"));
            fail("wrong bound wallet accepted");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("bound wallet"));
        }
        JSONObject wrongCluster = new JSONObject(v.policy.toString());
        wrongCluster.put("cluster", "devnet");
        reject(wallet, new SilverOpeningPolicy(wrongCluster), authority, response(v, v.message));
        JSONObject changedEnvelope = response(v, v.message);
        changedEnvelope.put("request", v.policy.getString("source"));
        reject(wallet, policy, authority, changedEnvelope);
    }

    @Test public void acceptsExactKitCandidateResponseAndRejectsMutations() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext()
                .getAssets().open("silver-opening-kit-vector.json")) {
            byte[] chunk = new byte[1024];
            int length;
            while ((length = input.read(chunk)) != -1) output.write(chunk, 0, length);
        }
        JSONObject vector = new JSONObject(new String(output.toByteArray(),
                java.nio.charset.StandardCharsets.UTF_8));
        SilverOpeningPolicy policy = new SilverOpeningPolicy(vector.getJSONObject("policy"));
        JSONObject response = vector.getJSONObject("response");
        SilverOpeningPolicy.Decoded decoded = policy.validateResponse(response);
        assertEquals(response.getString("walletAddress"), decoded.authority);
        assertEquals(response.getString("request"), decoded.request);
        byte[] altered = decoded.message();
        altered[altered.length - 1] ^= 1;
        JSONObject changed = new JSONObject(response.toString());
        changed.put("messageBase64", Base64.getEncoder().encodeToString(altered));
        try {
            policy.validateResponse(changed);
            fail("Kit message mutation accepted");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().length() > 0);
        }
    }

    private static void reject(AlphaWallet wallet, SilverOpeningPolicy policy,
            String authority, JSONObject changed) throws Exception {
        try {
            wallet.signSilverOpening(changed, policy, authority);
            fail("changed candidate reached Wallet Core signing");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().length() > 0);
        }
    }

    private static JSONObject response(Vector v, byte[] message) throws Exception {
        return new JSONObject().put("testOnly", true).put("cluster", "local-validator")
                .put("walletAddress", v.policy.getString("authority"))
                .put("mintAddress", v.policy.getString("mint"))
                .put("operation", v.policy.getString("operation"))
                .put("request", v.policy.getString("request"))
                .put("seedHex", v.policy.getString("seedHex"))
                .put("lastValidBlockHeight", 500)
                .put("messageBase64", Base64.getEncoder().encodeToString(message));
    }

    private static byte[] changed(byte[] original, int offset, int value) {
        byte[] copy = Arrays.copyOf(original, original.length);
        copy[offset] = (byte) value;
        return copy;
    }

    private static Vector vector(String authority) throws Exception {
        JSONObject policy = new JSONObject();
        policy.put("cluster", "local-validator");
        policy.put("seedHex", "0101010101010101010101010101010101010101010101010101010101010101");
        byte[][] keys = new byte[20][];
        for (int i = 0; i < keys.length; i++) {
            keys[i] = new byte[32];
            Arrays.fill(keys[i], (byte) (i + 31));
        }
        keys[0] = fromBase58(authority);
        keys[14] = fromBase58("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
        keys[15] = fromBase58("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        keys[16] = fromBase58("Sysvar1nstructions1111111111111111111111111");
        keys[17] = fromBase58("11111111111111111111111111111111");
        keys[19] = fromBase58("ComputeBudget111111111111111111111111111111");
        for (int i = 0; i < keys.length; i++) policy.put(FIELDS[i], base58(keys[i]));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(new byte[] { 1, 0, 11, 20 });
        for (byte[] key : keys) out.write(key);
        out.write(new byte[32]);
        byte[] raw = out.toByteArray();
        Arrays.fill(raw, raw.length - 32, raw.length, (byte) 23);
        out.reset();
        out.write(raw);
        int instructionCount = out.size();
        out.write(4);
        instruction(out, 19, new int[0], new byte[] { 2, 32, (byte) 0xd6, 19, 0 });
        int prepareProgram = out.size();
        byte[] prepare = new byte[33];
        prepare[0] = 12;
        Arrays.fill(prepare, 1, 33, (byte) 1);
        instruction(out, 18, OPEN, prepare);
        int transferStart = out.size();
        instruction(out, 15, TRANSFER, new byte[] { 12, 1, 0, 0, 0, 0, 0, 0, 0, 0 });
        int commitStart = out.size();
        prepare[0] = 13;
        instruction(out, 18, OPEN, prepare);
        return new Vector(policy, out.toByteArray(), instructionCount, prepareProgram,
                transferStart + 2 + 2, transferStart + 2 + TRANSFER.length + 1 + 1,
                commitStart + 2 + OPEN.length + 1 + 1, 4 + 9 * 32, 4 + 7 * 32);
    }

    private static void instruction(ByteArrayOutputStream out, int program, int[] accounts,
            byte[] data) {
        out.write(program);
        out.write(accounts.length);
        for (int index : accounts) out.write(index);
        out.write(data.length);
        out.write(data, 0, data.length);
    }

    private static byte[] fromBase58(String text) {
        BigInteger n = BigInteger.ZERO;
        for (int i = 0; i < text.length(); i++) {
            int digit = ALPHABET.indexOf(text.charAt(i));
            if (digit < 0) throw new IllegalArgumentException("bad address");
            n = n.multiply(BigInteger.valueOf(58)).add(BigInteger.valueOf(digit));
        }
        byte[] encoded = n.toByteArray();
        byte[] result = new byte[32];
        int length = Math.min(encoded.length, 32);
        System.arraycopy(encoded, encoded.length - length, result, 32 - length, length);
        return result;
    }

    private static String base58(byte[] bytes) {
        BigInteger n = new BigInteger(1, bytes);
        StringBuilder out = new StringBuilder();
        while (n.signum() > 0) {
            BigInteger[] div = n.divideAndRemainder(BigInteger.valueOf(58));
            out.append(ALPHABET.charAt(div[1].intValue()));
            n = div[0];
        }
        for (byte b : bytes) {
            if (b != 0) break;
            out.append('1');
        }
        return out.reverse().toString();
    }

    private static final class Vector {
        final JSONObject policy;
        final byte[] message;
        final int instructionCount, prepareProgram, transferEscrowIndex, transferAmount;
        final int commitSeed, mintKey, treasuryKey;

        Vector(JSONObject policy, byte[] message, int instructionCount, int prepareProgram,
                int transferEscrowIndex, int transferAmount, int commitSeed, int mintKey,
                int treasuryKey) {
            this.policy = policy;
            this.message = message;
            this.instructionCount = instructionCount;
            this.prepareProgram = prepareProgram;
            this.transferEscrowIndex = transferEscrowIndex;
            this.transferAmount = transferAmount;
            this.commitSeed = commitSeed;
            this.mintKey = mintKey;
            this.treasuryKey = treasuryKey;
        }
    }
}
