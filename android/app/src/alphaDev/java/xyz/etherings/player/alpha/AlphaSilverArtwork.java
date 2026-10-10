package xyz.etherings.player.alpha;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.LruCache;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.ring.SilverArtworkVerifier;
import xyz.etherings.player.ring.SilverInventorySnapshot;
import xyz.etherings.player.ring.SilverVerifiedMediaCache;

public final class AlphaSilverArtwork {
    private static final LruCache<String, Bitmap> DECODED = new LruCache<String, Bitmap>(16 * 1024) {
        @Override protected int sizeOf(String key, Bitmap value) {
            return Math.max(1, value.getByteCount() / 1024);
        }
    };
    private AlphaSilverArtwork() { }

    public static Map<String, Bitmap> load(Context context, SilverInventorySnapshot snapshot) {
        Map<String, Bitmap> artwork = new HashMap<>();
        for (SilverInventorySnapshot.Asset asset : snapshot.assets()) {
            Bitmap bitmap = loadOne(context, asset.uri, asset.contentHash);
            if (bitmap != null) artwork.put(asset.mint, bitmap);
        }
        return artwork;
    }

    // Draw Box artwork uses the same backend-supplied canonical URI/hash and
    // verified cache as inventory. No APK-side Box identity is introduced.
    public static Bitmap loadOne(Context context, String uri, String hash) {
        if (!SilverArtworkVerifier.validUri(uri) || !SilverArtworkVerifier.validHash(hash))
            return null;
        String key = uri + "\n" + hash;
        Bitmap decoded = DECODED.get(key);
        if (decoded != null && !decoded.isRecycled()) return decoded;
        SilverVerifiedMediaCache cache = new SilverVerifiedMediaCache(
                new java.io.File(context.getFilesDir(), "silver-media"),
                new java.io.File(context.getCacheDir(), "silver-media"));
        try {
            byte[] bytes = cache.read(uri, hash);
            if (bytes == null) {
                bytes = fetchAndStore(cache, uri, hash);
                if (bytes == null) return null;
            }
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = 4;
            decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            if (decoded != null) DECODED.put(key, decoded);
            return decoded;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static byte[] fetchAndStore(SilverVerifiedMediaCache cache, String uri, String hash) {
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) new URL(
                        BuildConfig.ALPHA_DEV_API_BASE_URL + "/media/ipfs/" +
                                uri.substring(7)).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(7000);
                connection.setReadTimeout(10000);
                int status = connection.getResponseCode();
                if (status == 502 || status == 503 || status == 504) continue;
                if (status != 200 ||
                        connection.getContentLength() > SilverArtworkVerifier.MAX_BYTES) return null;
                String mime = connection.getContentType();
                byte[] bytes;
                try (InputStream input = connection.getInputStream();
                     ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > SilverArtworkVerifier.MAX_BYTES) return null;
                        output.write(buffer, 0, count);
                    }
                    bytes = output.toByteArray();
                }
                return cache.store(uri, hash, mime, bytes) ? bytes : null;
            } catch (java.io.IOException ignored) {
                if (attempt == 1) return null;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        return null;
    }
}
