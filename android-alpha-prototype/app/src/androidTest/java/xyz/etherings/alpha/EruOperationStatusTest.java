package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class EruOperationStatusTest {
    @Test public void mapsOnlyStructuredBackendStates() throws Exception {
        assertEquals("pending", MainActivity.operationStatus(new AlphaApi.Result(200,
                new JSONObject().put("status", "pending"))));
        assertEquals("confirmed", MainActivity.operationStatus(new AlphaApi.Result(200,
                new JSONObject().put("status", "confirmed"))));
        assertEquals("failed", MainActivity.operationStatus(new AlphaApi.Result(409,
                new JSONObject().put("status", "failed"))));
        assertEquals("unknown", MainActivity.operationStatus(new AlphaApi.Result(503,
                new JSONObject().put("status", "unknown"))));
        assertNull(MainActivity.operationStatus(new AlphaApi.Result(503, new JSONObject())));
        assertNull(MainActivity.operationStatus(new AlphaApi.Result(409,
                new JSONObject().put("status", "confirmed"))));
        assertEquals("unknown", MainActivity.nextOperationStatus("unknown",
                new AlphaApi.Result(200, new JSONObject().put("status", "pending"))));
        assertEquals("unknown", MainActivity.nextOperationStatus("unknown",
                new AlphaApi.Result(503, new JSONObject())));
        assertEquals("confirmed", MainActivity.nextOperationStatus("unknown",
                new AlphaApi.Result(200, new JSONObject().put("status", "confirmed"))));
        assertEquals("failed", MainActivity.nextOperationStatus("unknown",
                new AlphaApi.Result(409, new JSONObject().put("status", "failed"))));
        assertEquals("confirmed", MainActivity.nextOperationStatus("confirmed",
                new AlphaApi.Result(503, new JSONObject().put("status", "unknown"))));
    }
}
