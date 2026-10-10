package xyz.etherings.player.sync;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

public interface StepBatchApi {
    JSONObject submitStepBatch(JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException;
}
