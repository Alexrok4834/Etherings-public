package xyz.etherings.player.api;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.auth.LoginApi;
import xyz.etherings.player.auth.MobileSessionApi;
import xyz.etherings.player.home.HomeProfileApi;
import xyz.etherings.player.profile.ProfileManagementApi;
import xyz.etherings.player.profile.ActivityHistoryApi;
import xyz.etherings.player.sync.StepBatchApi;
import xyz.etherings.player.ring.CopperRingApi;
import xyz.etherings.player.raffle.RaffleV2Api;

import java.net.URLEncoder;

public final class EtheringsApi implements MobileSessionApi, LoginApi, StepBatchApi, HomeProfileApi, ProfileManagementApi, ActivityHistoryApi, CopperRingApi, RaffleV2Api {
    private final ApiClient client;
    private final ApiConfig config;

    public EtheringsApi(ApiClient client) {
        this(client, ApiConfig.fromBuildConfig());
    }

    public EtheringsApi(ApiClient client, ApiConfig config) {
        this.client = client;
        this.config = config;
    }

    @Override
    public JSONObject mobilePasswordLogin(String username, String password, String installationId)
            throws IOException, JSONException, ApiException {
        assertSecureMobileSessionTransport();
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        body.put("installationId", installationId);
        return client.postJson("/auth/mobile-password", body, null);
    }

    @Override
    public JSONObject mobileRegister(String username, String password, String displayName, String installationId)
            throws IOException, JSONException, ApiException {
        assertSecureMobileSessionTransport();
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        body.put("displayName", displayName);
        body.put("installationId", installationId);
        return client.postJson("/auth/mobile-register", body, null);
    }

    @Override
    public JSONObject mobileRefresh(String refreshToken, String installationId)
            throws IOException, JSONException, ApiException {
        assertSecureMobileSessionTransport();
        JSONObject body = new JSONObject();
        body.put("refreshToken", refreshToken);
        body.put("installationId", installationId);
        return client.postJson("/auth/mobile-refresh", body, null);
    }

    @Override
    public void mobileLogout(String refreshToken) throws IOException, JSONException, ApiException {
        assertSecureMobileSessionTransport();
        JSONObject body = new JSONObject();
        body.put("refreshToken", refreshToken);
        client.postNoContent("/auth/mobile-logout", body);
    }

    public JSONObject profile(String accessToken) throws IOException, JSONException, ApiException {
        return client.getJson("/me", accessToken);
    }

    @Override
    public JSONObject rings(String accessToken) throws IOException, JSONException, ApiException {
        return client.getJson("/me/rings", accessToken);
    }

    @Override
    public JSONObject ring(String ringId, String accessToken) throws IOException, JSONException, ApiException {
        return client.getJson("/me/rings/" + ringId, accessToken);
    }

    @Override
    public JSONObject equippedRing(String accessToken) throws IOException, JSONException, ApiException {
        return client.getJson("/me/rings/equipped", accessToken);
    }

    @Override
    public JSONObject previewLevelUp(String ringId, JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        return client.postJson("/me/rings/" + ringId + "/level-up/preview", body, accessToken);
    }

    @Override
    public JSONObject levelUp(String ringId, JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        return client.postJson("/me/rings/" + ringId + "/level-up", body, accessToken);
    }

    @Override
    public JSONObject allocateAttributePoints(String ringId, JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        return client.postJson("/me/rings/" + ringId + "/attribute-points/allocate", body, accessToken);
    }

    @Override
    public JSONObject equipRing(String ringId, JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        return client.postJson("/me/rings/" + ringId + "/equip", body, accessToken);
    }

    @Override
    public JSONObject activityHistory(String from, String to, String accessToken)
            throws IOException, JSONException, ApiException {
        return client.getJson("/me/activity?from=" + from + "&to=" + to, accessToken);
    }

    @Override
    public JSONObject updateDisplayName(String displayName, String accessToken)
            throws IOException, JSONException, ApiException {
        JSONObject body = new JSONObject().put("displayName", displayName);
        return client.postJson("/me/display-name", body, accessToken);
    }

    @Override
    public JSONObject changePassword(String currentPassword, String newPassword, String accessToken)
            throws IOException, JSONException, ApiException {
        JSONObject body = new JSONObject()
                .put("currentPassword", currentPassword)
                .put("newPassword", newPassword);
        return client.postJson("/me/password", body, accessToken);
    }

    public JSONObject startWalkSession(String accessToken) throws IOException, JSONException, ApiException {
        JSONObject body = new JSONObject();
        body.put("source", "android_step_counter");
        return client.postJson("/walk/sessions/start", body, accessToken);
    }

    public JSONObject finishWalkSession(String sessionId, JSONObject finishBody, String accessToken) throws IOException, JSONException, ApiException {
        return client.postJson("/walk/sessions/" + sessionId + "/finish", finishBody, accessToken);
    }

    public JSONArray walkSessions(String accessToken) throws IOException, JSONException, ApiException {
        return client.getJsonArray("/walk/sessions", accessToken);
    }

    @Override
    public JSONObject currentDraw(String accessToken) throws IOException, JSONException, ApiException {
        return client.getJson("/raffle/v2/draw", accessToken);
    }

    @Override
    public JSONObject drawHistory(int limit, String cursor, String accessToken)
            throws IOException, JSONException, ApiException {
        if (limit < 1 || limit > 50) throw new IllegalArgumentException("history limit must be 1..50");
        String path = "/raffle/v2/history?limit=" + limit;
        if (cursor != null && !cursor.isEmpty()) {
            path += "&cursor=" + URLEncoder.encode(cursor, "UTF-8");
        }
        return client.getJson(path, accessToken);
    }

    @Override
    public JSONObject executeDraw(JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        return client.postJson("/raffle/v2/draw", body, accessToken);
    }

    @Override
    public JSONObject submitStepBatch(JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        return client.postJson("/step-sync/batches", body, accessToken);
    }

    private void assertSecureMobileSessionTransport() throws IOException {
        if (!config.isSecureMobileSessionTransport()) {
            throw new IOException("Mobile refresh credentials require HTTPS outside localhost");
        }
    }
}
