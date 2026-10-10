package xyz.etherings.player.ring;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

public interface CopperRingApi {
    JSONObject rings(String accessToken) throws IOException, JSONException, ApiException;

    JSONObject ring(String ringId, String accessToken) throws IOException, JSONException, ApiException;

    JSONObject equippedRing(String accessToken) throws IOException, JSONException, ApiException;

    default JSONObject previewLevelUp(String ringId, JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        throw new UnsupportedOperationException("Level-up preview is not implemented");
    }

    default JSONObject levelUp(String ringId, JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        throw new UnsupportedOperationException("Level-up is not implemented");
    }

    default JSONObject allocateAttributePoints(String ringId, JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        throw new UnsupportedOperationException("Attribute allocation is not implemented");
    }

    default JSONObject equipRing(String ringId, JSONObject body, String accessToken)
            throws IOException, JSONException, ApiException {
        throw new UnsupportedOperationException("Ring equipment is not implemented");
    }
}
