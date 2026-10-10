package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;

@RunWith(RobolectricTestRunner.class)
public final class AlphaEruSubmissionStoreTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private static final String ACCOUNT = "00000000-0000-4000-8000-000000000001";
    private static final String WALLET = "gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5";
    private static final String LEGACY = "00000000-0000-4000-8000-000000000002";
    private static final String CANONICAL = "00000000-0000-4000-8000-000000000003";

    @Test public void canonicalMarkerDoesNotConsumeOrDeleteHistoricalUnknown() throws Exception {
        File old = new File(folder.getRoot(), "alpha-dev-eru-submission-v1-" + ACCOUNT);
        try (DataOutputStream output = new DataOutputStream(new FileOutputStream(old))) {
            output.writeByte(1);
            output.writeUTF(ACCOUNT);
            output.writeUTF(WALLET);
            output.writeUTF(LEGACY);
        }
        AlphaEruSubmissionStore store = new AlphaEruSubmissionStore(folder.getRoot());
        assertTrue(store.hasHistoricalMarker(ACCOUNT));
        assertNull(store.load(ACCOUNT));
        store.save(ACCOUNT, WALLET, CANONICAL);
        assertEquals(CANONICAL, store.load(ACCOUNT).intentId);
        store.clearIf(ACCOUNT, WALLET, CANONICAL);
        assertNull(store.load(ACCOUNT));
        assertTrue(old.exists());
        assertTrue(store.hasHistoricalMarker(ACCOUNT));
        assertFalse(store.hasHistoricalMarker("00000000-0000-4000-8000-000000000004"));
    }
}
