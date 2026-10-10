package xyz.etherings.player.auth;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

public interface LoginApi {
    JSONObject mobilePasswordLogin(String username, String password, String installationId)
            throws IOException, JSONException, ApiException;

    JSONObject mobileRegister(String username, String password, String displayName, String installationId)
            throws IOException, JSONException, ApiException;

    JSONObject profile(String accessToken) throws IOException, JSONException, ApiException;
}
