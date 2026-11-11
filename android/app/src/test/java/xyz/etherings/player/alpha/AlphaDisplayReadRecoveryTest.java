package xyz.etherings.player.alpha;

import static org.junit.Assert.*;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public final class AlphaDisplayReadRecoveryTest {
    @Test public void failedClaimInvalidationDiscardsEvenCompleteInitialInventory() throws Exception {
        AtomicLong revision = new AtomicLong(10);
        AtomicInteger claims = new AtomicInteger(), reads = new AtomicInteger();
        AlphaDisplayReadRecovery.Result<String> result = AlphaDisplayReadRecovery.read(revision::get,
                () -> true, () -> {
                    claims.incrementAndGet();
                    revision.incrementAndGet(); // starter HTTP503 -> preview clear -> recovered starter
                    return "all three initial snapshots present";
                }, () -> { reads.incrementAndGet(); return "fresh verified inventory"; });
        assertEquals("fresh verified inventory", result.value);
        assertEquals(11, result.revision);
        assertEquals(1, claims.get()); assertEquals(1, reads.get());
    }
    @Test public void successfulUnchangedReadAddsNoRecovery() throws Exception {
        assertEquals("initial", AlphaDisplayReadRecovery.read(() -> 1, () -> true,
                () -> "initial", () -> { fail("extra request"); return "bad"; }).value);
    }
    @Test public void crossedDisplayGetFailureCanRecover() throws Exception {
        AtomicLong revision = new AtomicLong();
        assertEquals("fresh", AlphaDisplayReadRecovery.read(revision::get, () -> true,
                () -> { revision.incrementAndGet(); throw new IllegalStateException("crossed revision"); },
                () -> "fresh").value);
    }
    @Test public void ordinaryFailureDoesNotStartRetryLoop() {
        assertThrows(IOException.class, () -> AlphaDisplayReadRecovery.read(() -> 1, () -> true,
                () -> { throw new IOException(); }, () -> { fail("extra request"); return "bad"; }));
    }
    @Test public void mutationDuringRecoveryRejectsAndNeverRetriesAgain() {
        AtomicLong revision = new AtomicLong();
        AtomicInteger reads = new AtomicInteger();
        assertThrows(IllegalStateException.class, () -> AlphaDisplayReadRecovery.read(revision::get,
                () -> true, () -> { revision.incrementAndGet(); return "old"; },
                () -> { reads.incrementAndGet(); revision.incrementAndGet(); return "crossed"; }));
        assertEquals(1, reads.get());
    }
    @Test public void changedSessionCannotRecoverIntoAnotherAccount() {
        AtomicLong revision = new AtomicLong();
        assertThrows(IllegalStateException.class, () -> AlphaDisplayReadRecovery.read(revision::get,
                () -> false, () -> { revision.incrementAndGet(); return "old"; },
                () -> { fail("must not load different account"); return "bad"; }));
    }
    @Test public void sessionChangeDuringRecoveryRejects() {
        AtomicLong revision = new AtomicLong();
        AtomicInteger session = new AtomicInteger();
        assertThrows(IllegalStateException.class, () -> AlphaDisplayReadRecovery.read(revision::get,
                () -> session.get() == 0, () -> { revision.incrementAndGet(); return "old"; },
                () -> { session.incrementAndGet(); return "other account"; }));
    }
}
