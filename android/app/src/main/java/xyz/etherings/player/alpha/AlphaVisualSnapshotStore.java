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
    private static long readSequence;
    private static final String PROCESS = java.util.UUID.randomUUID().toString();
    public long beginRead() { synchronized (LOCK) { return ++readSequence; } }
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
                // Rings contains the Home preview fields too; no starter identity
                // is invented in the opposite direction.
                if (row == null && "home".equals(screen)) row = root.optJSONObject("rings");
                if (row == null) return null;
                long age = System.currentTimeMillis() - row.getLong("at");
                if (age < 0 || age > MAX_AGE_MS) return null;
                JSONObject data = new JSONObject(row.getJSONObject("data").toString());
                if ("home".equals(screen) || "rings".equals(screen)) {
                    JSONObject shared = root.optJSONObject("inventoryPreview");
                    if (shared != null) {
                        long sharedAge = System.currentTimeMillis() - shared.getLong("at");
                        // Wallet/Home do not necessarily read listing status. For
                        // Rings, keep its complete, age-checked preview rather than
                        // make listed items appear unlisted. Fresh reads still gate actions.
                        JSONObject ownInventory = data.optJSONObject("silver");
                        boolean keepRingsListings = "rings".equals(screen) &&
                                ownInventory != null && ownInventory.optBoolean("listingStatusAvailable", false) &&
                                !shared.getJSONObject("data").optBoolean("listingStatusAvailable", false);
                        if (sharedAge >= 0 && sharedAge <= MAX_AGE_MS && !keepRingsListings)
                            data.put("silver", new JSONObject(shared.getJSONObject("data").toString()));
                    }
                }
                return data;
            } catch (Exception error) {
                AlphaDisplayDiagnostics.failure(AlphaDisplayDiagnostics.Stage.PREVIEW_FILE, error);
                revision++; file.delete(); return null;
            }
        }
    }
    private static boolean olderThan(JSONObject row, long order) {
        return row != null && PROCESS.equals(row.optString("process")) &&
                row.optLong("order", 0) > order;
    }
    private static JSONObject row(JSONObject data, long now, long order) throws Exception {
        return new JSONObject().put("at", now).put("data", new JSONObject(data.toString()))
                .put("process", PROCESS).put("order", order);
    }
    public void save(String owner, String lineage, String screen, JSONObject data, long expectedRevision) {
        save(owner, lineage, screen, data, expectedRevision, beginRead());
    }
    public void save(String owner, String lineage, String screen, JSONObject data,
            long expectedRevision, long readOrder) {
        if (!("home".equals(screen) || "rings".equals(screen) || "wallet".equals(screen))) return;
        synchronized (LOCK) {
            if (expectedRevision != revision) return;
            FileOutputStream output = null;
            try {
                JSONObject root = readRoot();
                if (!owner.equals(root.optString("owner")) || !lineage.equals(root.optString("lineage")))
                    root = new JSONObject().put("owner", owner).put("lineage", lineage);
                JSONObject previous = root.optJSONObject(screen);
                if (olderThan(previous, readOrder)) return;
                long now = System.currentTimeMillis();
                root.put(screen, row(data, now, readOrder));
                JSONObject inventory = data.optJSONObject("silver");
                if (inventory != null && !olderThan(root.optJSONObject("inventoryPreview"), readOrder)) {
                    // Callers validate the full inventory before saving. Revalidate
                    // here so malformed previews cannot contaminate another screen.
                    xyz.etherings.player.ring.SilverInventorySnapshot.parse(inventory);
                    root.put("inventoryPreview", row(inventory, now, readOrder));
                }
                byte[] bytes = root.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_BYTES) return;
                output = file.startWrite();
                output.write(bytes);
                file.finishWrite(output);
            } catch (Exception ignored) { if (output != null) file.failWrite(output); }
        }
    }
}
