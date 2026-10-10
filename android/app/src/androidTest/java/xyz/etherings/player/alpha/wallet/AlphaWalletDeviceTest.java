package xyz.etherings.player.alpha.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;

import wallet.core.jni.CoinType;
import wallet.core.jni.HDWallet;
import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.BindingChallenge;

public final class AlphaWalletDeviceTest {
    private static final String ALPHABET =
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static final String COMPUTE_BUDGET =
            "ComputeBudget111111111111111111111111111111";

    @Test
    public void createRestoreSignAndDeleteOnPhysicalDevice() throws Exception {
        assertTrue("Run only in the isolated smoke application ID",
                BuildConfig.APPLICATION_ID.endsWith(".walletsmoke"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AlphaWallet wallet = new AlphaWallet(context);
        wallet.delete();
        char[] phrase = null;
        try {
            String originalAddress;
            try (AlphaWallet.Creation creation = wallet.create()) {
                originalAddress = creation.address;
                phrase = creation.recoveryPhrase();
                assertEquals(originalAddress, wallet.address());
                assertThrows(IllegalStateException.class, wallet::create);
            }
            File envelope = new File(context.getNoBackupFilesDir(),
                    "alpha-wallet-envelope.bin");
            assertTrue(envelope.isFile());
            byte[] ciphertext = Files.readAllBytes(envelope.toPath());
            assertFalse(new String(ciphertext, StandardCharsets.ISO_8859_1)
                    .contains(new String(phrase, 0, Math.min(8, phrase.length))));

            GatewayTransferIntent first = intent(originalAddress, 30_000_000_000L, 1);
            byte[] message = message(first);
            byte[] signature = wallet.signGatewayMessage(message, first);
            assertEquals(64, signature.length);
            HDWallet independent = new HDWallet(new String(phrase), "");
            assertTrue(independent.getKey(CoinType.SOLANA, AlphaWallet.DERIVATION_PATH)
                    .getPublicKeyEd25519().verify(signature, message));

            long issuedAtMs = System.currentTimeMillis();
            long expiresAtMs = issuedAtMs + 600_000;
            byte[] bindingMessage = ("EtheRings Alpha wallet binding\nversion=1\naccount=" +
                    "11111111-2222-3333-4444-555555555555\nwallet=" + originalAddress +
                    "\nenvironment=alpha-local\nnonce=" + "a".repeat(64) +
                    "\nissued_at_ms=" + issuedAtMs + "\nexpires_at_ms=" + expiresAtMs + "\n")
                    .getBytes(StandardCharsets.US_ASCII);
            BindingChallenge challenge = BindingChallenge.decode(
                    java.util.Base64.getEncoder().encodeToString(bindingMessage), "a".repeat(64),
                    expiresAtMs, "11111111-2222-3333-4444-555555555555", originalAddress,
                    "alpha-local", issuedAtMs);
            byte[] bindingSignature = wallet.signBinding(challenge,
                    "11111111-2222-3333-4444-555555555555", "alpha-local");
            assertTrue(independent.getKey(CoinType.SOLANA, AlphaWallet.DERIVATION_PATH)
                    .getPublicKeyEd25519().verify(bindingSignature, bindingMessage));
            assertThrows(IllegalArgumentException.class,
                    () -> wallet.signBinding(challenge, "aaaaaaaa-2222-3333-4444-555555555555", "alpha-local"));
            assertThrows(IllegalArgumentException.class,
                    () -> wallet.signBinding(challenge, "11111111-2222-3333-4444-555555555555", "alpha-other"));

            byte[] changedAmount = Arrays.copyOf(message, message.length);
            changedAmount[changedAmount.length - 24] ^= 1;
            assertThrows(IllegalArgumentException.class,
                    () -> wallet.signGatewayMessage(changedAmount, first));
            assertFalse(independent.getKey(CoinType.SOLANA, AlphaWallet.DERIVATION_PATH)
                    .getPublicKeyEd25519().verify(signature, changedAmount));
            for (int offset : new int[]{0, 2, 4 + 32, 4 + 32 * 2,
                    4 + 32 * 3, 4 + 32 * 6, 4 + 32 * 12}) {
                byte[] altered = Arrays.copyOf(message, message.length);
                altered[offset] ^= 1;
                assertThrows(IllegalArgumentException.class,
                        () -> wallet.signGatewayMessage(altered, first));
            }
            byte[] extraInstruction = Arrays.copyOf(message, message.length + 3);
            extraInstruction[4 + 32 * 14 + 32] = 3;
            assertThrows(IllegalArgumentException.class,
                    () -> wallet.signGatewayMessage(extraInstruction, first));
            GatewayTransferIntent wrongDestination = new GatewayTransferIntent(
                    first.authority, first.source, key((byte) 42), first.treasury,
                    first.config, first.replay, first.mint, first.meta, first.sysvar,
                    first.tokenProgram, first.hook, first.systemProgram, first.gateway,
                    first.amount, first.nonce, first.expiry);
            assertThrows(IllegalArgumentException.class,
                    () -> wallet.signGatewayMessage(message, wrongDestination));

            AlphaWallet restarted = new AlphaWallet(context);
            assertEquals(originalAddress, restarted.address());
            GatewayTransferIntent second = intent(originalAddress, 1_000_000_000L, 2);
            byte[] secondMessage = message(second);
            assertEquals(64, restarted.signGatewayMessage(secondMessage, second).length);

            restarted.delete();
            assertFalse(envelope.exists());
            assertThrows(IllegalStateException.class, restarted::address);
            assertThrows(IllegalArgumentException.class,
                    () -> wallet.restoreFromMnemonic("invalid phrase".toCharArray()));
            assertFalse(envelope.exists());
            assertEquals(originalAddress, wallet.restoreFromMnemonic(phrase));
            assertEquals(originalAddress, wallet.address());
        } finally {
            wallet.delete();
            if (phrase != null) Arrays.fill(phrase, '\0');
        }
        assertFalse(new File(context.getNoBackupFilesDir(),
                "alpha-wallet-envelope.bin").exists());
    }

    private static GatewayTransferIntent intent(String authority, long amount, long nonce) {
        return new GatewayTransferIntent(authority, key((byte) 1), key((byte) 2),
                key((byte) 3), key((byte) 4), key((byte) 5), key((byte) 6),
                key((byte) 7), key((byte) 8), key((byte) 9), key((byte) 10),
                key((byte) 11), key((byte) 12), amount, nonce, 9_999_999);
    }

    private static byte[] message(GatewayTransferIntent intent) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(1);
        out.write(0);
        out.write(8);
        out.write(14);
        for (String account : new String[]{intent.authority, intent.source,
                intent.destination, intent.treasury, intent.config, intent.replay,
                intent.mint, intent.meta, intent.sysvar, intent.tokenProgram,
                intent.hook, intent.systemProgram, intent.gateway, COMPUTE_BUDGET}) {
            out.write(base58Decode(account), 0, 32);
        }
        byte[] blockhash = new byte[32];
        Arrays.fill(blockhash, (byte) 77);
        out.write(blockhash, 0, blockhash.length);
        out.write(2);
        out.write(13);
        out.write(0);
        out.write(5);
        out.write(new byte[]{2, (byte) 0xC0, 0x27, 0x09, 0}, 0, 5);
        out.write(12);
        out.write(13);
        out.write(new byte[]{1, 6, 2, 3, 0, 4, 7, 8, 9, 10, 5, 0, 11}, 0, 13);
        out.write(25);
        out.write(1);
        writeU64(out, intent.amount);
        writeU64(out, intent.nonce);
        writeU64(out, intent.expiry);
        return out.toByteArray();
    }

    private static void writeU64(ByteArrayOutputStream out, long value) {
        for (int i = 0; i < 8; i++) out.write((int) (value >>> (8 * i)) & 255);
    }

    private static String key(byte value) {
        byte[] bytes = new byte[32];
        Arrays.fill(bytes, value);
        BigInteger number = new BigInteger(1, bytes);
        StringBuilder encoded = new StringBuilder();
        while (number.signum() > 0) {
            BigInteger[] div = number.divideAndRemainder(BigInteger.valueOf(58));
            encoded.append(ALPHABET.charAt(div[1].intValue()));
            number = div[0];
        }
        return encoded.reverse().toString();
    }

    private static byte[] base58Decode(String encoded) {
        BigInteger number = BigInteger.ZERO;
        for (int i = 0; i < encoded.length(); i++) {
            int digit = ALPHABET.indexOf(encoded.charAt(i));
            if (digit < 0) throw new IllegalArgumentException("invalid test address");
            number = number.multiply(BigInteger.valueOf(58)).add(BigInteger.valueOf(digit));
        }
        byte[] raw = number.toByteArray();
        byte[] result = new byte[32];
        System.arraycopy(raw, Math.max(0, raw.length - 32), result,
                Math.max(0, 32 - raw.length), Math.min(32, raw.length));
        return result;
    }
}
