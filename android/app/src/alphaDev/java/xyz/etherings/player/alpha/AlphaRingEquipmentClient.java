package xyz.etherings.player.alpha;

import android.content.Context;
import org.json.JSONObject;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.ring.AlphaRingEquipmentSnapshot;

public final class AlphaRingEquipmentClient {
    private AlphaRingEquipmentClient() { }

    public static AlphaRingEquipmentSnapshot load(Context context) throws Exception {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        String token = sessions.load();
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/ring/equipment", token);
        if (!token.equals(sessions.load())) throw new IllegalStateException("Alpha session changed");
        if (result.status != 200) throw new IllegalStateException("Ring selection unavailable");
        return AlphaRingEquipmentSnapshot.parse(result.body);
    }

    public static String equip(Context context, AlphaRingEquipmentSnapshot current,
            String kind, String id, String idempotencyKey) throws Exception {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        String token = sessions.load();
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        JSONObject request = new JSONObject()
                .put("contractVersion", "alpha-ring-equipment-v1")
                .put("target", AlphaRingEquipmentSnapshot.key(kind, id).json())
                .put("expectedCurrent", current.selection.json())
                .put("expectedVersion", current.version)
                .put("idempotencyKey", idempotencyKey);
        AlphaM2eComfortBoundary.close(context);
        AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .post("/ring/equipment/equip", request, token);
        if (!token.equals(sessions.load())) throw new IllegalStateException("Alpha session changed");
        if (result.status == 200) {
            if (!"alpha-ring-equipment-v1".equals(result.body.getString("contractVersion")) ||
                    !kind.equals(result.body.getJSONObject("current").getString("kind")) ||
                    !id.equals(result.body.getJSONObject("current").getString("id")))
                throw new IllegalStateException("Ring Equip response mismatch");
            AlphaM2eComfortBoundary.close(context);
            return "OK";
        }
        String cooldownNotice = AlphaSilverCooldownNotice.forResponse(
                result.status, result.body);
        return cooldownNotice != null ? cooldownNotice :
                result.body.optString("code", "RING_EQUIPMENT_UNAVAILABLE");
    }
}
