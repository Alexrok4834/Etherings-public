package xyz.etherings.player.alpha;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.LruCache;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.ring.CopperRing;
import xyz.etherings.player.ring.CopperRingVisualCatalog;

/** Alpha-only transport for the existing versioned MVP Cooper artwork. */
public final class AlphaCooperArtwork {
    private static final int MAX_BYTES = 3_000_000;
    private static final LruCache<String, Bitmap> DECODED = new LruCache<String, Bitmap>(16 * 1024) {
        @Override protected int sizeOf(String key, Bitmap value) {
            return Math.max(1, value.getByteCount() / 1024);
        }
    };

    private AlphaCooperArtwork() { }

    public static Map<String, Bitmap> load(Context context, List<CopperRing> rings) {
        return load(context, rings, true);
    }

    public static Map<String, Bitmap> loadForCollection(Context context, List<CopperRing> rings) {
        return load(context, rings, false);
    }

    private static Map<String, Bitmap> load(Context context, List<CopperRing> rings, boolean trim) {
        Map<String, Bitmap> artwork = new HashMap<>();
        try {
            AlphaSessionStore sessions = new AlphaSessionStore(context);
            String token = sessions.load();
            if (token == null) return artwork;
            JSONObject images = catalog(context, sessions, token, rings).getJSONObject("images");
            for (CopperRing ring : rings) {
                String code = ring.visualVariantCode();
                if (artwork.containsKey(code) ||
                        !CopperRingVisualCatalog.VISUAL_SET_VERSION.equals(ring.visualSetVersion()))
                    continue;
                JSONObject entry = images.optJSONObject(code);
                if (entry == null) continue;
                String path = entry.getString("path");
                String hash = entry.getString("sha256");
                if (!path.equals("/media/cooper/copper-visual-v1/" + code + ".png") ||
                        !hash.matches("[a-f0-9]{64}")) continue;
                Bitmap image = loadOne(context, path, hash, trim);
                if (image != null) artwork.put(code, image);
            }
        } catch (Exception ignored) { }
        return artwork;
    }

    private static JSONObject catalog(Context context, AlphaSessionStore sessions,
            String token, List<CopperRing> rings) throws Exception {
        File directory = new File(context.getFilesDir(), "cooper-media");
        File file = new File(directory, "catalog-v1.json");
        JSONObject cached = readCatalog(file, rings);
        if (cached != null) return cached;
        cached = readCatalog(new File(context.getCacheDir(), "cooper-media/catalog-v1.json"), rings);
        if (cached != null) {
            storeCatalog(file, cached);
            return cached;
        }
        AlphaAuthApi.Result response = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/media/cooper/catalog", token);
        if (response.status != 200 || !token.equals(sessions.load()) ||
                !validCatalog(response.body, rings))
            throw new IllegalStateException("Cooper media catalog unavailable");
        storeCatalog(file, response.body);
        return response.body;
    }

    private static JSONObject readCatalog(File file, List<CopperRing> rings) {
        if (!file.isFile() || file.length() > 16_384) return null;
        try {
            JSONObject catalog = new JSONObject(new String(Files.readAllBytes(file.toPath()),
                    StandardCharsets.UTF_8));
            if (validCatalog(catalog, rings)) return catalog;
        } catch (Exception ignored) { }
        file.delete();
        return null;
    }

    private static void storeCatalog(File file, JSONObject catalog) {
        File directory = file.getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) return;
        File pending = null;
        try {
            pending = File.createTempFile("cooper-catalog-", ".tmp", directory);
            try (FileOutputStream output = new FileOutputStream(pending)) {
                output.write(catalog.toString().getBytes(StandardCharsets.UTF_8));
            }
            pending.renameTo(file);
        } catch (Exception ignored) { }
        finally { if (pending != null) pending.delete(); }
    }

    private static boolean validCatalog(JSONObject catalog, List<CopperRing> rings) {
        try {
            if (!CopperRingVisualCatalog.VISUAL_SET_VERSION.equals(catalog.getString("version")))
                return false;
            JSONObject images = catalog.getJSONObject("images");
            for (CopperRing ring : rings) {
                String code = ring.visualVariantCode();
                JSONObject entry = images.getJSONObject(code);
                if (!entry.getString("path").equals(
                        "/media/cooper/copper-visual-v1/" + code + ".png") ||
                        !entry.getString("sha256").matches("[a-f0-9]{64}")) return false;
            }
            return true;
        } catch (Exception ignored) { return false; }
    }

    private static Bitmap loadOne(Context context, String path, String hash, boolean trim) {
        String key = path + "\n" + hash + "\n" + trim;
        Bitmap decoded = DECODED.get(key);
        if (decoded != null && !decoded.isRecycled()) return decoded;
        File directory = new File(context.getFilesDir(), "cooper-media");
        File file = new File(directory, hash + ".png");
        byte[] bytes = readPng(file, hash);
        try {
            if (bytes == null) {
                bytes = readPng(new File(context.getCacheDir(),
                        "cooper-media/" + hash + ".png"), hash);
                if (bytes != null) storePng(file, bytes);
            }
            if (bytes == null) {
                HttpsURLConnection connection = (HttpsURLConnection) new URL(
                        BuildConfig.ALPHA_DEV_API_BASE_URL + path).openConnection();
                try {
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(7_000);
                    connection.setReadTimeout(10_000);
                    if (connection.getResponseCode() != 200 ||
                            connection.getContentLength() > MAX_BYTES ||
                            !"image/png".equals(connection.getContentType())) return null;
                    try (InputStream input = connection.getInputStream();
                         ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                        byte[] chunk = new byte[8192];
                        int count;
                        while ((count = input.read(chunk)) != -1) {
                            if (output.size() + count > MAX_BYTES) return null;
                            output.write(chunk, 0, count);
                        }
                        bytes = output.toByteArray();
                    }
                } finally { connection.disconnect(); }
                if (!verified(bytes, hash)) return null;
                storePng(file, bytes);
            }
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = 4;
            decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            decoded = trim ? trimTransparentMargins(decoded) : decoded;
            if (decoded != null) DECODED.put(key, decoded);
            return decoded;
        } catch (Exception ignored) { return null; }
    }

    private static byte[] readPng(File file, String hash) {
        if (!file.isFile() || file.length() > MAX_BYTES) return null;
        try {
            byte[] bytes = Files.readAllBytes(file.toPath());
            if (verified(bytes, hash)) return bytes;
        } catch (Exception ignored) { }
        file.delete();
        return null;
    }

    private static void storePng(File file, byte[] bytes) {
        File directory = file.getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) return;
        File pending = null;
        try {
            pending = File.createTempFile("cooper-", ".tmp", directory);
            try (FileOutputStream output = new FileOutputStream(pending)) {
                output.write(bytes);
            }
            pending.renameTo(file);
        } catch (Exception ignored) { }
        finally { if (pending != null) pending.delete(); }
    }

    static Bitmap trimTransparentMargins(Bitmap image) {
        if (image == null || !image.hasAlpha()) return image;
        int width = image.getWidth(), height = image.getHeight();
        int[] pixels = new int[width * height];
        image.getPixels(pixels, 0, width, 0, 0, width, height);
        int left = width, top = height, right = -1, bottom = -1;
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            if ((pixels[y * width + x] >>> 24) <= 16) continue;
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        if (right < left) return image;
        int padding = Math.max(1, Math.min(width, height) / 24);
        left = Math.max(0, left - padding); top = Math.max(0, top - padding);
        right = Math.min(width - 1, right + padding);
        bottom = Math.min(height - 1, bottom + padding);
        return left == 0 && top == 0 && right == width - 1 && bottom == height - 1 ?
                image : Bitmap.createBitmap(image, left, top, right - left + 1, bottom - top + 1);
    }

    static boolean verified(byte[] bytes, String hash) {
        if (bytes == null || bytes.length < 33 || bytes.length > MAX_BYTES ||
                hash == null || !hash.matches("[a-f0-9]{64}")) return false;
        byte[] png = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};
        for (int i = 0; i < png.length; i++) if (bytes[i] != png[i]) return false;
        if (bytes[12] != 'I' || bytes[13] != 'H' || bytes[14] != 'D' || bytes[15] != 'R' ||
                dimension(bytes, 16) < 1 || dimension(bytes, 16) > 4096 ||
                dimension(bytes, 20) < 1 || dimension(bytes, 20) > 4096) return false;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            char[] digits = "0123456789abcdef".toCharArray();
            for (int i = 0; i < digest.length; i++)
                if (hash.charAt(i * 2) != digits[(digest[i] & 255) >>> 4] ||
                        hash.charAt(i * 2 + 1) != digits[digest[i] & 15]) return false;
            return true;
        } catch (Exception ignored) { return false; }
    }

    private static int dimension(byte[] bytes, int offset) {
        return ((bytes[offset] & 255) << 24) | ((bytes[offset + 1] & 255) << 16) |
                ((bytes[offset + 2] & 255) << 8) | (bytes[offset + 3] & 255);
    }
}
