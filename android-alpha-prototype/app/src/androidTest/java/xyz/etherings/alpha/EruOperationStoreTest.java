package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class EruOperationStoreTest {
    @Test public void persistsUnknownAcrossInstancesAndIsolatesAccountWalletAndCluster() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String storeName = "alpha-eru-operation-test";
        context.getSharedPreferences(storeName, Context.MODE_PRIVATE).edit().clear().commit();
        EruOperationStore first = new EruOperationStore(context, storeName);
        String id = "00000000-0000-4000-8000-000000000001";
        first.save(new EruOperationStore.Operation(id, "account-a", "wallet-a", "devnet", "unknown"));
        EruOperationStore restored = new EruOperationStore(context, storeName);
        assertEquals("unknown", restored.load("account-a", "wallet-a", "devnet").status);
        assertNull(restored.load("account-b", "wallet-a", "devnet"));
        assertNull(restored.load("account-a", "wallet-b", "devnet"));
        assertNull(restored.load("account-a", "wallet-a", "local-validator"));
        restored.save(new EruOperationStore.Operation(
                "00000000-0000-4000-8000-000000000002", "account-b", "wallet-b", "devnet", "failed"));
        assertEquals("unknown", first.load("account-a", "wallet-a", "devnet").status);
        assertEquals("failed", first.load("account-b", "wallet-b", "devnet").status);
        restored.save(new EruOperationStore.Operation(id, "account-a", "wallet-a", "devnet", "confirmed"));
        assertEquals("confirmed", first.load("account-a", "wallet-a", "devnet").status);
        context.getSharedPreferences(storeName, Context.MODE_PRIVATE).edit().clear().commit();
    }
}
