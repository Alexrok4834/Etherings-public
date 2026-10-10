package xyz.etherings.player.auth;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class SessionStore implements SessionCredentialStore {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "etherings_mobile_session_v1";
    private static final String PREFS_NAME = "etherings_secure_session";
    private static final String ACCESS_TOKEN_CIPHERTEXT = "access_token_ciphertext";
    private static final String ACCESS_TOKEN_IV = "access_token_iv";
    private static final String OWNER_ID_CIPHERTEXT = "owner_id_ciphertext";
    private static final String OWNER_ID_IV = "owner_id_iv";
    private static final String SESSION_CIPHERTEXT = "session_v2_ciphertext";
    private static final String SESSION_IV = "session_v2_iv";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    private final SharedPreferences preferences;

    public SessionStore(Context context) {
        this.preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public void saveAccessToken(String accessToken) throws GeneralSecurityException {
        if (accessToken == null || accessToken.trim().isEmpty()) {
            throw new IllegalArgumentException("accessToken is required");
        }

        EncryptedValue encrypted = encrypt(accessToken);
        preferences.edit()
                .putString(ACCESS_TOKEN_CIPHERTEXT, encrypted.ciphertext)
                .putString(ACCESS_TOKEN_IV, encrypted.iv)
                .apply();
    }

    public void saveSession(String accessToken, String ownerId) throws GeneralSecurityException {
        requireValue(accessToken, "accessToken");
        requireOwnerId(ownerId);
        EncryptedValue encryptedToken = encrypt(accessToken);
        EncryptedValue encryptedOwner = encrypt(ownerId);
        preferences.edit()
                .putString(ACCESS_TOKEN_CIPHERTEXT, encryptedToken.ciphertext)
                .putString(ACCESS_TOKEN_IV, encryptedToken.iv)
                .putString(OWNER_ID_CIPHERTEXT, encryptedOwner.ciphertext)
                .putString(OWNER_ID_IV, encryptedOwner.iv)
                .apply();
    }

    @Override
    public synchronized void saveCredentials(SessionCredentials credentials) throws GeneralSecurityException {
        if (credentials == null) {
            throw new IllegalArgumentException("credentials are required");
        }
        JSONObject value = new JSONObject();
        try {
            value.put("accessToken", credentials.accessToken());
            value.put("refreshToken", credentials.refreshToken());
            value.put("refreshTokenExpiresAt", credentials.refreshTokenExpiresAt());
            value.put("ownerId", credentials.ownerId());
            value.put("installationId", credentials.installationId());
        } catch (JSONException error) {
            throw new GeneralSecurityException("Could not encode session credentials", error);
        }
        EncryptedValue encrypted = encrypt(value.toString());
        boolean committed = preferences.edit()
                .putString(SESSION_CIPHERTEXT, encrypted.ciphertext)
                .putString(SESSION_IV, encrypted.iv)
                .remove(ACCESS_TOKEN_CIPHERTEXT)
                .remove(ACCESS_TOKEN_IV)
                .remove(OWNER_ID_CIPHERTEXT)
                .remove(OWNER_ID_IV)
                .commit();
        if (!committed) {
            throw new GeneralSecurityException("Could not persist session credentials");
        }
    }

    @Override
    public synchronized SessionCredentials getCredentials() throws GeneralSecurityException {
        String ciphertext = preferences.getString(SESSION_CIPHERTEXT, null);
        String iv = preferences.getString(SESSION_IV, null);
        if (ciphertext == null || iv == null) {
            return null;
        }
        try {
            JSONObject value = new JSONObject(decrypt(ciphertext, iv));
            return new SessionCredentials(
                    value.optString("accessToken", ""),
                    value.optString("refreshToken", ""),
                    value.optString("refreshTokenExpiresAt", ""),
                    value.optString("ownerId", ""),
                    value.optString("installationId", "")
            );
        } catch (JSONException | IllegalArgumentException error) {
            throw new GeneralSecurityException("Saved session credentials are invalid", error);
        }
    }

    @Override
    public synchronized boolean replaceIfCurrent(SessionCredentials expected, SessionCredentials replacement)
            throws GeneralSecurityException {
        return SessionCredentialStore.super.replaceIfCurrent(expected, replacement);
    }

    @Override
    public synchronized boolean clearIfCurrent(SessionCredentials expected) throws GeneralSecurityException {
        return SessionCredentialStore.super.clearIfCurrent(expected);
    }

    public void saveOwnerId(String ownerId) throws GeneralSecurityException {
        requireOwnerId(ownerId);
        EncryptedValue encrypted = encrypt(ownerId);
        preferences.edit()
                .putString(OWNER_ID_CIPHERTEXT, encrypted.ciphertext)
                .putString(OWNER_ID_IV, encrypted.iv)
                .apply();
    }

    public String getAccessToken() throws GeneralSecurityException {
        SessionCredentials credentials = getCredentials();
        if (credentials != null) {
            return credentials.accessToken();
        }
        String encodedCiphertext = preferences.getString(ACCESS_TOKEN_CIPHERTEXT, null);
        String encodedIv = preferences.getString(ACCESS_TOKEN_IV, null);

        if (encodedCiphertext == null || encodedIv == null) {
            return null;
        }

        return decrypt(encodedCiphertext, encodedIv);
    }

    public String getOwnerId() throws GeneralSecurityException {
        SessionCredentials credentials = getCredentials();
        if (credentials != null) {
            return credentials.ownerId();
        }
        String encodedCiphertext = preferences.getString(OWNER_ID_CIPHERTEXT, null);
        String encodedIv = preferences.getString(OWNER_ID_IV, null);
        if (encodedCiphertext == null || encodedIv == null) {
            return null;
        }
        String ownerId = decrypt(encodedCiphertext, encodedIv);
        requireOwnerId(ownerId);
        return ownerId;
    }

    public boolean hasAccessToken() {
        return hasCredentials()
                || preferences.contains(ACCESS_TOKEN_CIPHERTEXT) && preferences.contains(ACCESS_TOKEN_IV);
    }

    public boolean hasOwnerId() {
        return hasCredentials()
                || preferences.contains(OWNER_ID_CIPHERTEXT) && preferences.contains(OWNER_ID_IV);
    }

    public boolean hasCredentials() {
        return preferences.contains(SESSION_CIPHERTEXT) && preferences.contains(SESSION_IV);
    }

    @Override
    public synchronized void clear() {
        preferences.edit()
                .remove(SESSION_CIPHERTEXT)
                .remove(SESSION_IV)
                .remove(ACCESS_TOKEN_CIPHERTEXT)
                .remove(ACCESS_TOKEN_IV)
                .remove(OWNER_ID_CIPHERTEXT)
                .remove(OWNER_ID_IV)
                .apply();
    }

    private EncryptedValue encrypt(String value) throws GeneralSecurityException {
        requireValue(value, "value");
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey());
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return new EncryptedValue(
                Base64.encodeToString(ciphertext, Base64.NO_WRAP),
                Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
        );
    }

    private String decrypt(String encodedCiphertext, String encodedIv) throws GeneralSecurityException {
        byte[] ciphertext = Base64.decode(encodedCiphertext, Base64.NO_WRAP);
        byte[] iv = Base64.decode(encodedIv, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private void requireOwnerId(String ownerId) {
        requireValue(ownerId, "ownerId");
        try {
            UUID.fromString(ownerId);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("ownerId must be a UUID", error);
        }
    }

    private void requireValue(String value, String name) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(name + " is required");
        }
    }

    private static final class EncryptedValue {
        final String ciphertext;
        final String iv;

        EncryptedValue(String ciphertext, String iv) {
            this.ciphertext = ciphertext;
            this.iv = iv;
        }
    }

    private SecretKey getOrCreateSecretKey() throws GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        try {
            keyStore.load(null);
        } catch (Exception error) {
            throw new GeneralSecurityException("Failed to load Android Keystore", error);
        }

        KeyStore.Entry existingEntry = keyStore.getEntry(KEY_ALIAS, null);
        if (existingEntry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existingEntry).getSecretKey();
        }

        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec keySpec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build();

        keyGenerator.init(keySpec);
        return keyGenerator.generateKey();
    }
}
