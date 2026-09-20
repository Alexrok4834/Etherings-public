package xyz.etherings.player.alpha.wallet;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class AlphaWalletStore {
    private static final String ALIAS = "etherings_alpha_wallet_v1";
    private static final int VERSION = 1;
    private final AtomicFile envelope;

    AlphaWalletStore(Context context) {
        envelope = new AtomicFile(new File(context.getNoBackupFilesDir(),
                "alpha-wallet-envelope.bin"));
    }

    boolean exists() {
        return envelope.getBaseFile().exists();
    }

    void save(String mnemonic) throws Exception {
        if (exists()) throw new IllegalStateException("wallet already exists");
        KeyStore store = keyStore();
        if (store.containsAlias(ALIAS)) {
            throw new IllegalStateException("wallet key exists without envelope");
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        SecretKey key = generator.generateKey();
        byte[] plain = mnemonic.getBytes(StandardCharsets.UTF_8);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] encrypted = cipher.doFinal(plain);
            java.io.FileOutputStream output = null;
            try {
                output = envelope.startWrite();
                DataOutputStream data = new DataOutputStream(output);
                data.writeInt(VERSION);
                data.writeInt(cipher.getIV().length);
                data.write(cipher.getIV());
                data.writeInt(encrypted.length);
                data.write(encrypted);
                data.flush();
                envelope.finishWrite(output);
            } catch (Exception error) {
                if (output != null) envelope.failWrite(output);
                throw error;
            }
        } catch (Exception error) {
            envelope.delete();
            store.deleteEntry(ALIAS);
            throw error;
        } finally {
            Arrays.fill(plain, (byte) 0);
        }
    }

    String load() throws Exception {
        if (!exists()) throw new IllegalStateException("wallet not created");
        byte[] iv;
        byte[] encrypted;
        try (DataInputStream input = new DataInputStream(envelope.openRead())) {
            if (input.readInt() != VERSION) throw new IllegalStateException("wallet version mismatch");
            int ivLength = input.readInt();
            if (ivLength != 12) throw new IllegalStateException("invalid wallet IV");
            iv = new byte[ivLength];
            input.readFully(iv);
            int length = input.readInt();
            if (length < 16 || length > 512) throw new IllegalStateException("invalid wallet envelope");
            encrypted = new byte[length];
            input.readFully(encrypted);
            if (input.read() != -1) throw new IllegalStateException("trailing wallet data");
        }
        SecretKey key = (SecretKey) keyStore().getKey(ALIAS, null);
        if (key == null) throw new IllegalStateException("wallet Keystore key unavailable");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        byte[] plain = cipher.doFinal(encrypted);
        try {
            return new String(plain, StandardCharsets.UTF_8);
        } finally {
            Arrays.fill(plain, (byte) 0);
        }
    }

    void delete() throws Exception {
        envelope.delete();
        KeyStore store = keyStore();
        if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
        if (exists() || store.containsAlias(ALIAS)) {
            throw new IllegalStateException("wallet reset incomplete");
        }
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }
}
