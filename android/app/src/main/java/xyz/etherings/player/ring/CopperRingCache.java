package xyz.etherings.player.ring;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

public final class CopperRingCache {
    static final String PREFS_NAME = "etherings_copper_ring_cache_v1";
    private static final String OWNER_ID = "owner_id";
    private static final String INVENTORY_JSON = "inventory_json";
    private static final String INVENTORY_CACHED_AT = "inventory_cached_at";
    private static final String DETAIL_JSON = "detail_json";
    private static final String DETAIL_RING_ID = "detail_ring_id";
    private static final String DETAIL_CACHED_AT = "detail_cached_at";
    private static final String EQUIPPED_JSON = "equipped_json";
    private static final String EQUIPPED_CACHED_AT = "equipped_cached_at";

    interface Clock {
        long nowMs();
    }

    public static final class Snapshot<T> {
        private final T value;
        private final long cachedAtMs;

        Snapshot(T value, long cachedAtMs) {
            this.value = value;
            this.cachedAtMs = cachedAtMs;
        }

        public T value() { return value; }
        public long cachedAtMs() { return cachedAtMs; }
    }

    private final SharedPreferences preferences;
    private final Clock clock;

    public CopperRingCache(Context context) {
        this(context, System::currentTimeMillis);
    }

    CopperRingCache(Context context, Clock clock) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.clock = clock;
    }

    public synchronized void saveInventory(String ownerId, List<CopperRing> rings) {
        requireOwnerId(ownerId);
        if (rings == null) throw new IllegalArgumentException("rings are required");
        JSONArray encoded = new JSONArray();
        for (CopperRing ring : rings) {
            if (ring == null) throw new IllegalArgumentException("ring is required");
            encoded.put(ring.toJson());
        }
        ownerEditor(ownerId)
                .putString(INVENTORY_JSON, encoded.toString())
                .putLong(INVENTORY_CACHED_AT, clock.nowMs())
                .commit();
    }

    public synchronized Snapshot<List<CopperRing>> inventory(String ownerId) {
        if (!ownerMatches(ownerId)) return null;
        String encoded = preferences.getString(INVENTORY_JSON, null);
        if (encoded == null) return null;
        try {
            JSONArray array = new JSONArray(encoded);
            List<CopperRing> rings = new ArrayList<>();
            for (int index = 0; index < array.length(); index++) {
                rings.add(CopperRing.fromJson(array.getJSONObject(index)));
            }
            return new Snapshot<>(
                    Collections.unmodifiableList(rings),
                    preferences.getLong(INVENTORY_CACHED_AT, 0L)
            );
        } catch (JSONException | IllegalArgumentException error) {
            return null;
        }
    }

    public synchronized void saveDetail(String ownerId, CopperRing ring) {
        requireOwnerId(ownerId);
        if (ring == null) throw new IllegalArgumentException("ring is required");
        ownerEditor(ownerId)
                .putString(DETAIL_RING_ID, ring.id())
                .putString(DETAIL_JSON, ring.toJson().toString())
                .putLong(DETAIL_CACHED_AT, clock.nowMs())
                .commit();
    }

    public synchronized Snapshot<CopperRing> detail(String ownerId, String ringId) {
        if (!ownerMatches(ownerId) || ringId == null || !ringId.equals(preferences.getString(DETAIL_RING_ID, null))) {
            return null;
        }
        String encoded = preferences.getString(DETAIL_JSON, null);
        if (encoded == null) return null;
        try {
            CopperRing ring = CopperRing.fromJson(new JSONObject(encoded));
            if (!ringId.equals(ring.id())) return null;
            return new Snapshot<>(ring, preferences.getLong(DETAIL_CACHED_AT, 0L));
        } catch (JSONException | IllegalArgumentException error) {
            return null;
        }
    }

    public synchronized void saveEquipped(String ownerId, EquippedCopperRing equipped) {
        requireOwnerId(ownerId);
        if (equipped == null) throw new IllegalArgumentException("equipped ring is required");
        ownerEditor(ownerId)
                .putString(EQUIPPED_JSON, equipped.toJson().toString())
                .putLong(EQUIPPED_CACHED_AT, clock.nowMs())
                .commit();
    }

    public synchronized Snapshot<EquippedCopperRing> equipped(String ownerId) {
        if (!ownerMatches(ownerId)) return null;
        String encoded = preferences.getString(EQUIPPED_JSON, null);
        if (encoded == null) return null;
        try {
            return new Snapshot<>(
                    EquippedCopperRing.fromJson(new JSONObject(encoded)),
                    preferences.getLong(EQUIPPED_CACHED_AT, 0L)
            );
        } catch (JSONException | IllegalArgumentException error) {
            return null;
        }
    }

    public synchronized void clearForOwner(String ownerId) {
        if (ownerMatches(ownerId)) preferences.edit().clear().commit();
    }

    private SharedPreferences.Editor ownerEditor(String ownerId) {
        String cachedOwner = preferences.getString(OWNER_ID, null);
        SharedPreferences.Editor editor = preferences.edit();
        if (cachedOwner != null && !ownerId.equals(cachedOwner)) editor.clear();
        return editor.putString(OWNER_ID, ownerId);
    }

    private boolean ownerMatches(String ownerId) {
        return ownerId != null && ownerId.equals(preferences.getString(OWNER_ID, null));
    }

    private void requireOwnerId(String ownerId) {
        if (ownerId == null) throw new IllegalArgumentException("ownerId is required");
        UUID.fromString(ownerId);
    }
}
