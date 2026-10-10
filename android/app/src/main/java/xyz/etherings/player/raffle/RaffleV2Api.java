package xyz.etherings.player.raffle;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

public interface RaffleV2Api {
    JSONObject currentDraw(String accessToken) throws IOException, JSONException, ApiException;

    JSONObject drawHistory(int limit, String cursor, String accessToken)
            throws IOException, JSONException, ApiException;

    JSONObject executeDraw(JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException;
}
