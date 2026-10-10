package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

public final class CopperMutationRetryKeyTest {
    @Test
    public void transportRetryReusesKeyUntilRequestChangesOrCommits() {
        AtomicInteger generated = new AtomicInteger();
        CopperMutationRetryKey tracker = new CopperMutationRetryKey(
                () -> "key-" + generated.incrementAndGet());

        String first = tracker.keyFor("ring:1:payload-a");
        assertEquals(first, tracker.keyFor("ring:1:payload-a"));
        String changed = tracker.keyFor("ring:1:payload-b");
        assertNotEquals(first, changed);
        tracker.clear();
        assertNotEquals(changed, tracker.keyFor("ring:1:payload-b"));
        assertEquals(3, generated.get());
    }
}
