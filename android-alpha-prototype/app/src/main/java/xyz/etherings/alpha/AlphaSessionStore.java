package xyz.etherings.alpha;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class AlphaSessionStore {
    private static final String ALIAS = "etherings-alpha-auth-session-v1";
    private final File file;

    AlphaSessionStore(Context context) {
        file = new File(context.getNoBackupFilesDir(), "alpha-session-v1");
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }

    void save(String token) throws Exception {
        if (token == null || !token.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid session");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(token.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        File temporary = new File(file.getParentFile(), file.getName() + ".new");
        try (DataOutputStream output = new DataOutputStream(new FileOutputStream(temporary))) {
            output.writeByte(1);
            output.writeByte(cipher.getIV().length);
            output.write(cipher.getIV());
            output.writeInt(encrypted.length);
            output.write(encrypted);
        }
        if (!temporary.renameTo(file)) {
            temporary.delete();
            throw new IllegalStateException("Session persistence failed");
        }
    }

    String load() {
        if (!file.isFile()) return null;
        try (DataInputStream input = new DataInputStream(new FileInputStream(file))) {
            if (input.readUnsignedByte() != 1 || input.readUnsignedByte() != 12) throw new IllegalStateException();
            byte[] iv = new byte[12];
            input.readFully(iv);
            int size = input.readInt();
            if (size < 16 || size > 256) throw new IllegalStateException();
            byte[] encrypted = new byte[size];
            input.readFully(encrypted);
            if (input.read() != -1) throw new IllegalStateException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            String token = new String(cipher.doFinal(encrypted), java.nio.charset.StandardCharsets.US_ASCII);
            if (!token.matches("[a-f0-9]{64}")) throw new IllegalStateException();
            return token;
        } catch (Exception ignored) {
            clear();
            return null;
        }
    }

    void clear() {
        if (file.exists()) file.delete();
        File temporary = new File(file.getParentFile(), file.getName() + ".new");
        if (temporary.exists()) temporary.delete();
    }
}
