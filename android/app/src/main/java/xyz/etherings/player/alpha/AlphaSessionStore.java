package xyz.etherings.player.alpha;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class AlphaSessionStore {
    private static final String ALIAS = "etherings-main-alpha-dev-session-v1";
    private static final Object FILE_LOCK = new Object();
    private final File file;

    public AlphaSessionStore(Context context) {
        file = new File(context.getNoBackupFilesDir(), "alpha-dev-session-v1");
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
        synchronized (FILE_LOCK) { write(AlphaSessionIdentity.legacy(token)); }
    }

    void saveVerified(String token, String accountId) throws Exception {
        saveVerified(token, accountId, null, null, null);
    }

    void saveVerified(String token, String accountId, String refreshToken,
                      String refreshExpiresAt, String installationId) throws Exception {
        synchronized (FILE_LOCK) {
            AlphaSessionIdentity current = read();
            if (current == null || !current.token.equals(token))
                throw new IllegalStateException("Alpha session changed during verification");
            write(refreshToken == null ? AlphaSessionIdentity.verified(token, accountId) :
                    AlphaSessionIdentity.renewable(token, accountId, refreshToken,
                            refreshExpiresAt, installationId, java.util.UUID.randomUUID().toString()));
        }
    }

    AlphaSessionIdentity current() {
        synchronized (FILE_LOCK) { return read(); }
    }

    boolean sameLineage(AlphaSessionIdentity expected) {
        synchronized (FILE_LOCK) {
            AlphaSessionIdentity current = read();
            return current != null && expected != null &&
                    java.util.Objects.equals(current.accountId, expected.accountId) &&
                    (expected.lineage == null ? current.token.equals(expected.token) :
                            expected.lineage.equals(current.lineage));
        }
    }

    boolean replaceIfCurrent(AlphaSessionIdentity expected, String accessToken,
                             String refreshToken, String refreshExpiresAt) throws Exception {
        synchronized (FILE_LOCK) {
            AlphaSessionIdentity current = read();
            if (current == null || !current.token.equals(expected.token) ||
                    !current.refreshToken.equals(expected.refreshToken) ||
                    !current.lineage.equals(expected.lineage)) return false;
            write(AlphaSessionIdentity.renewable(accessToken, current.accountId, refreshToken,
                    refreshExpiresAt, current.installationId, current.lineage));
            return true;
        }
    }

    boolean clearIfCurrent(AlphaSessionIdentity expected) {
        synchronized (FILE_LOCK) {
            AlphaSessionIdentity current = read();
            if (current == null || expected == null || !current.token.equals(expected.token) ||
                    !java.util.Objects.equals(current.lineage, expected.lineage)) return false;
            clear();
            return true;
        }
    }

    private void write(AlphaSessionIdentity identity) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(identity.encode().getBytes(StandardCharsets.US_ASCII));
        File temporary = new File(file.getParentFile(), file.getName() + ".new");
        try (DataOutputStream output = new DataOutputStream(new FileOutputStream(temporary))) {
            output.writeByte(identity.accountId == null ? 1 : identity.refreshToken == null ? 2 : 3);
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
        synchronized (FILE_LOCK) {
            AlphaSessionIdentity identity = read();
            return identity == null ? null : identity.token;
        }
    }

    String ownerId() {
        synchronized (FILE_LOCK) {
            AlphaSessionIdentity identity = read();
            return identity == null ? null : identity.accountId;
        }
    }

    public VerifiedSession verified() {
        synchronized (FILE_LOCK) {
            AlphaSessionIdentity identity = read();
            return identity == null || identity.accountId == null
                    ? null : new VerifiedSession(identity.token, identity.accountId, identity.lineage);
        }
    }

    public static final class VerifiedSession {
        private final String token;
        private final String ownerId;
        private final String lineage;

        VerifiedSession(String token, String ownerId) {
            this(token, ownerId, token);
        }

        VerifiedSession(String token, String ownerId, String lineage) {
            this.token = token;
            this.ownerId = ownerId;
            this.lineage = lineage;
        }

        public String token() { return token; }
        public String ownerId() { return ownerId; }
        public String lineage() { return lineage; }
    }

    private AlphaSessionIdentity read() {
        if (!file.isFile()) return null;
        try (DataInputStream input = new DataInputStream(new FileInputStream(file))) {
            int version = input.readUnsignedByte();
            if ((version != 1 && version != 2 && version != 3) || input.readUnsignedByte() != 12)
                throw new IllegalStateException();
            byte[] iv = new byte[12];
            input.readFully(iv);
            int size = input.readInt();
            if (size < 16 || size > 1024) throw new IllegalStateException();
            byte[] encrypted = new byte[size];
            input.readFully(encrypted);
            if (input.read() != -1) throw new IllegalStateException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            String plaintext = new String(cipher.doFinal(encrypted), StandardCharsets.US_ASCII);
            return AlphaSessionIdentity.decode(version, plaintext);
        } catch (Exception ignored) {
            clear();
            return null;
        }
    }

    void clear() {
        synchronized (FILE_LOCK) {
            if (file.exists()) file.delete();
            File temporary = new File(file.getParentFile(), file.getName() + ".new");
            if (temporary.exists()) temporary.delete();
        }
    }
}
