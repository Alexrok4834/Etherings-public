package xyz.etherings.player.auth;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

public interface MobileSessionApi {
    JSONObject mobilePasswordLogin(String username, String password, String installationId)
            throws IOException, JSONException, ApiException;

    JSONObject mobileRefresh(String refreshToken, String installationId)
            throws IOException, JSONException, ApiException;

    void mobileLogout(String refreshToken) throws IOException, JSONException, ApiException;
}
