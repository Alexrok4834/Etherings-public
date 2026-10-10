package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.Assume;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class EruExistingOperationTest {
    @Test public void seedUnknownForExistingAuthenticatedDevnetOperation() throws Exception {
        String id = InstrumentationRegistry.getArguments().getString("operationId");
        Assume.assumeNotNull(id);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String token = new AlphaSessionStore(context).load();
        assertNotNull("Verified Alpha session is required", token);
        AlphaApi api = new AlphaApi(BuildConfig.ALPHA_API_BASE_URL);
        AlphaApi.Result me = api.get("/auth/me", token);
        AlphaApi.Result wallet = api.get("/wallet", token);
        assertEquals(200, me.status);
        assertEquals(200, wallet.status);
        String account = me.body.getString("id");
        String address = wallet.body.getString("walletAddress");
        assertEquals(address, new AlphaWallet(context).address());
        AlphaApi.Result operation = api.post("/eru/reconcile",
                new org.json.JSONObject().put("id", id), token);
        assertEquals("Only an existing confirmed operation can be seeded", 200, operation.status);
        assertEquals("confirmed", operation.body.getString("status"));
        String localStatus = InstrumentationRegistry.getArguments().getString("localStatus", "unknown");
        if (!EruOperationStore.validStatus(localStatus))
            throw new IllegalArgumentException("Invalid localStatus");
        new EruOperationStore(context).save(new EruOperationStore.Operation(
                id, account, address, "devnet", localStatus));
    }
}
