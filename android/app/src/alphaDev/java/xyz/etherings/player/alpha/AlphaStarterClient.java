package xyz.etherings.player.alpha;

import android.content.Context;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayList;
import java.util.List;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.ring.AlphaStarterSnapshot;
import xyz.etherings.player.ring.CopperRing;

public final class AlphaStarterClient {
    private AlphaStarterClient() { }

    public static AlphaStarterSnapshot load(Context context) throws Exception {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        String token = sessions.load();
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        AlphaAuthApi api = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL);
        AlphaAuthApi.Result response;
        try { response = api.post("/starter/claim", new JSONObject(), token); }
        catch (Exception ignored) { response = null; }
        if (!token.equals(sessions.load()))
            throw new IllegalStateException("Alpha session changed");
        if (response == null || response.status != 200) {
            AlphaAuthApi.Result inventory = api.get("/starter/inventory", token);
            if (!token.equals(sessions.load()) || inventory.status != 200)
                throw new IllegalStateException("Alpha Cooper inventory unavailable");
            List<CopperRing> owned = parseInventory(inventory.body);
            return new AlphaStarterSnapshot(
                    CopperRing.fromJson(inventory.body.getJSONObject("ring")), "unknown", owned);
        }
        CopperRing starter = CopperRing.fromJson(response.body.getJSONObject("ring"));
        List<CopperRing> rings = new ArrayList<>();
        JSONArray items = response.body.optJSONArray("rings");
        if (items == null) rings.add(starter);
        else for (int i = 0; i < items.length(); i++)
            rings.add(CopperRing.fromJson(items.getJSONObject(i)));
        return new AlphaStarterSnapshot(starter,
                response.body.getJSONObject("silver").getString("status"), rings);
    }

    // Home only reads the already-issued Cooper inventory. /starter/claim may
    // reserve a Silver Box after wallet binding and must not gate Home artwork.
    public static List<CopperRing> loadInventory(Context context) throws Exception {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        String token = sessions.load();
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        AlphaAuthApi.Result response = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/starter/inventory", token);
        if (!token.equals(sessions.load()) || response.status != 200)
            throw new IllegalStateException("Alpha Cooper inventory unavailable");
        return parseInventory(response.body);
    }

    static List<CopperRing> parseInventory(JSONObject body) throws Exception {
        CopperRing starter = CopperRing.fromJson(body.getJSONObject("ring"));
        JSONArray items = body.getJSONArray("rings");
        List<CopperRing> rings = new ArrayList<>();
        for (int i = 0; i < items.length(); i++)
            rings.add(CopperRing.fromJson(items.getJSONObject(i)));
        if (rings.stream().noneMatch(ring -> ring.id().equals(starter.id())))
            throw new IllegalStateException("Starter Cooper absent from inventory");
        return rings;
    }
}
