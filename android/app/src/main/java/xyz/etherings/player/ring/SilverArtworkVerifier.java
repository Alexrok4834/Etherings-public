package xyz.etherings.player.ring;

import java.security.MessageDigest;
import java.util.regex.Pattern;

public final class SilverArtworkVerifier {
    private static final Pattern URI = Pattern.compile("ipfs://bafy[a-z2-7]{55}(/[A-Za-z0-9_-]+\\.png)?");
    private static final Pattern HASH = Pattern.compile("[a-f0-9]{64}");
    public static final int MAX_BYTES = 3_000_000;

    private SilverArtworkVerifier() { }

    public static boolean validUri(String uri) {
        return uri != null && URI.matcher(uri).matches();
    }

    public static boolean validHash(String hash) {
        return hash != null && HASH.matcher(hash).matches();
    }

    public static boolean matches(String uri, String hash, String mime, byte[] bytes) {
        if (!validUri(uri) || !validHash(hash) || !"image/png".equals(mime) ||
                bytes == null || bytes.length < 33 || bytes.length > MAX_BYTES) return false;
        byte[] png = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};
        for (int i = 0; i < png.length; i++) if (bytes[i] != png[i]) return false;
        if (bytes[12] != 'I' || bytes[13] != 'H' || bytes[14] != 'D' || bytes[15] != 'R' ||
                dimension(bytes, 16) != 1254 || dimension(bytes, 20) != 1254 ||
                bytes[24] != 8 || bytes[25] != 6) return false;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            char[] digits = "0123456789abcdef".toCharArray();
            for (int i = 0; i < digest.length; i++) {
                if (hash.charAt(i * 2) != digits[(digest[i] & 255) >>> 4] ||
                        hash.charAt(i * 2 + 1) != digits[digest[i] & 15]) return false;
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static int dimension(byte[] bytes, int offset) {
        return ((bytes[offset] & 255) << 24) | ((bytes[offset + 1] & 255) << 16) |
                ((bytes[offset + 2] & 255) << 8) | (bytes[offset + 3] & 255);
    }
}
