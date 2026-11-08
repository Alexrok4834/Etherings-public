package xyz.etherings.player.alpha;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Display previews only. A successful read never grants permission to act. */
public final class AlphaVisualSnapshotStore {
    private static final Object LOCK = new Object();
    private static long revision;
    private static final int MAX_BYTES = 262144;
    private static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;
    private final AtomicFile file;
    public AlphaVisualSnapshotStore(Context context) {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "alpha-visual-v1.json"));
    }
    public long revision() { synchronized (LOCK) { return revision; } }
    public void clear() { synchronized (LOCK) { revision++; file.delete(); } }
    private JSONObject readRoot() throws Exception {
        if (!file.getBaseFile().exists()) return new JSONObject();
        if (file.getBaseFile().length() > MAX_BYTES) throw new IllegalStateException("Preview too large");
        return new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
    }
    public JSONObject load(String owner, String lineage, String screen) {
        synchronized (LOCK) {
            try {
                JSONObject root = readRoot();
                if (root.length() == 0) return null;
                if (!owner.equals(root.optString("owner")) ||
                        !lineage.equals(root.optString("lineage"))) { revision++; file.delete(); return null; }
                JSONObject row = root.optJSONObject(screen);
                if (row == null) return null;
                long age = System.currentTimeMillis() - row.getLong("at");
                if (age < 0 || age > MAX_AGE_MS) return null;
                return row.getJSONObject("data");
            } catch (Exception ignored) { revision++; file.delete(); return null; }
        }
    }
    public void save(String owner, String lineage, String screen, JSONObject data, long expectedRevision) {
        if (!("home".equals(screen) || "rings".equals(screen) || "wallet".equals(screen))) return;
        synchronized (LOCK) {
            if (expectedRevision != revision) return;
            FileOutputStream output = null;
            try {
                JSONObject root = readRoot();
                if (!owner.equals(root.optString("owner")) || !lineage.equals(root.optString("lineage")))
                    root = new JSONObject().put("owner", owner).put("lineage", lineage);
                root.put(screen, new JSONObject().put("at", System.currentTimeMillis()).put("data", data));
                byte[] bytes = root.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_BYTES) return;
                output = file.startWrite();
                output.write(bytes);
                file.finishWrite(output);
            } catch (Exception ignored) { if (output != null) file.failWrite(output); }
        }
    }
}
