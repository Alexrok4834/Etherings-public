package xyz.etherings.player.home;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

public interface HomeProfileApi {
    JSONObject profile(String accessToken) throws IOException, JSONException, ApiException;
}
