package xyz.etherings.player.alpha;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class AlphaDisplayDiagnosticsTest {
    @Test public void reportsWrappedFailureCategoryWithoutMessageOrIdentity() {
        ShadowLog.clear();
        AlphaDisplayDiagnostics.failure(AlphaDisplayDiagnostics.Stage.RINGS_INVENTORY,
                new java.util.concurrent.ExecutionException(new java.lang.reflect.InvocationTargetException(
                        new IllegalStateException("secret-token-and-wallet"))));
        String message = ShadowLog.getLogsForTag("AlphaDisplay").get(0).msg;
        assertEquals("RINGS_INVENTORY failure=state", message);
        assertFalse(message.contains("secret"));
        assertNull(ShadowLog.getLogsForTag("AlphaDisplay").get(0).throwable);
    }

    @Test public void distinguishesTimeoutAndRevisionRejection() {
        ShadowLog.clear();
        AlphaDisplayDiagnostics.failure(AlphaDisplayDiagnostics.Stage.RINGS_STARTER,
                new java.net.SocketTimeoutException("private endpoint"));
        AlphaDisplayDiagnostics.rejected(AlphaDisplayDiagnostics.Stage.RINGS_REJECT, true, true, false, false);
        assertEquals("RINGS_STARTER failure=timeout", ShadowLog.getLogsForTag("AlphaDisplay").get(0).msg);
        assertEquals("RINGS_REJECT revisionChanged=true first=true second=false third=false",
                ShadowLog.getLogsForTag("AlphaDisplay").get(1).msg);
    }
}
