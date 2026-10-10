package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.SessionExpiredException;
import xyz.etherings.player.sync.StepBatchApi;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AlphaStepBatchAccessTest {
    private final String ownerA = UUID.randomUUID().toString();
    private final String ownerB = UUID.randomUUID().toString();
    private final String installation = UUID.randomUUID().toString();

    @Test public void unverifiedOrSignedOutSessionCannotSelectAnOutbox() {
        AlphaStepBatchAccess access = new AlphaStepBatchAccess(() -> null, installation);
        assertNull(access.current());
    }

    @Test public void switchedAccountCannotSendOldOwnersBatch() throws Exception {
        AtomicReference<AlphaSessionStore.VerifiedSession> session = new AtomicReference<>(
                new AlphaSessionStore.VerifiedSession("token-a", ownerA));
        AlphaStepBatchAccess access = new AlphaStepBatchAccess(session::get, installation);
        assertEquals(ownerA, access.current().ownerId());
        session.set(new AlphaSessionStore.VerifiedSession("token-b", ownerB));
        StepBatchApi noSend = (payload, token) -> {
            fail("Old owner's batch was sent");
            return null;
        };
        try {
            access.submitForOwner(ownerA, installation, noSend, new JSONObject());
            fail("Owner switch must require authorization");
        } catch (SessionExpiredException expected) {
            assertEquals(ownerB, access.current().ownerId());
        }
    }

    @Test public void matchingOwnerAndInstallationUseOnlyCurrentAlphaToken() throws Exception {
        AlphaStepBatchAccess access = new AlphaStepBatchAccess(
                () -> new AlphaSessionStore.VerifiedSession("current-token", ownerA), installation);
        JSONObject response = new JSONObject().put("status", "ACCEPTED");
        assertEquals(response, access.submitForOwner(ownerA, installation, (payload, token) -> {
            assertEquals("current-token", token);
            return response;
        }, new JSONObject()));
    }

    @Test public void wrongInstallationAndHttp401NeverBecomeTerminalRejection() throws Exception {
        AlphaStepBatchAccess access = new AlphaStepBatchAccess(
                () -> new AlphaSessionStore.VerifiedSession("current-token", ownerA), installation);
        StepBatchApi rejected = (payload, token) -> { throw new ApiException(401, "unauthorized"); };
        try {
            access.submitForOwner(ownerA, UUID.randomUUID().toString(), rejected, new JSONObject());
            fail("Wrong installation must not be sent");
        } catch (SessionExpiredException expected) { }
        try {
            access.submitForOwner(ownerA, installation, rejected, new JSONObject());
            fail("401 must keep batch retryable after sign-in");
        } catch (SessionExpiredException expected) { }
    }

    @Test public void disabledDevRouteKeepsBatchRetryable() throws Exception {
        AlphaStepBatchAccess access = new AlphaStepBatchAccess(
                () -> new AlphaSessionStore.VerifiedSession("current-token", ownerA), installation);
        try {
            access.submitForOwner(ownerA, installation,
                    (payload, token) -> { throw new ApiException(404, "route off"); }, new JSONObject());
            fail("Disabled route must not reject the batch permanently");
        } catch (IOException expected) { }
    }
}
