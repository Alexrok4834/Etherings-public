package xyz.etherings.player.profile;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

public interface ProfileManagementApi {
    JSONObject updateDisplayName(String displayName, String accessToken)
            throws IOException, JSONException, ApiException;

    JSONObject changePassword(String currentPassword, String newPassword, String accessToken)
            throws IOException, JSONException, ApiException;
}
