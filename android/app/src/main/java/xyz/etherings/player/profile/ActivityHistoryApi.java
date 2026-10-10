package xyz.etherings.player.profile;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

public interface ActivityHistoryApi {
    JSONObject activityHistory(String from, String to, String accessToken)
            throws IOException, JSONException, ApiException;
}
