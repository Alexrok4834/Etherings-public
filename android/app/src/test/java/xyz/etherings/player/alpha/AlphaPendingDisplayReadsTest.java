package xyz.etherings.player.alpha;

import static org.junit.Assert.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public final class AlphaPendingDisplayReadsTest {
    private static void awaitWaiting(Thread thread) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (thread.getState() != Thread.State.WAITING && System.nanoTime() < end) Thread.sleep(1);
        assertEquals(Thread.State.WAITING, thread.getState());
    }

    @Test public void concurrentSameReadSharesOnceButNextReadRefreshes() throws Exception {
        AlphaPendingDisplayReads reads = new AlphaPendingDisplayReads();
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        Callable<String> load = () -> { calls.incrementAndGet(); started.countDown();
            if (!release.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("test timeout");
            return "first"; };
        FutureTask<String> one = new FutureTask<>(() -> reads.read("account/session/revision/path", load));
        FutureTask<String> two = new FutureTask<>(() -> reads.read("account/session/revision/path", load));
        Thread owner = new Thread(one), waiter = new Thread(two);
        try {
            owner.start(); assertTrue(started.await(3, TimeUnit.SECONDS));
            waiter.start(); awaitWaiting(waiter);
            release.countDown();
            assertEquals("first", one.get(3, TimeUnit.SECONDS));
            assertEquals("first", two.get(3, TimeUnit.SECONDS));
            assertEquals(1, calls.get());
            assertEquals("external-change", reads.read("account/session/revision/path", () -> "external-change"));
        } finally { release.countDown(); owner.join(3000); waiter.join(3000); }
    }

    @Test public void differentIdentityRevisionOrPathNeverJoinsAndFailureIsRetried() throws Exception {
        AlphaPendingDisplayReads reads = new AlphaPendingDisplayReads();
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        FutureTask<String> one = new FutureTask<>(() -> reads.read("old", () -> {
            started.countDown(); release.await(3, TimeUnit.SECONDS); return "old"; }));
        Thread owner = new Thread(one);
        try {
            owner.start(); assertTrue(started.await(3, TimeUnit.SECONDS));
            assertEquals("new", reads.read("new", () -> "new"));
            assertThrows(IllegalStateException.class, () -> reads.read("failure", () -> { throw new IllegalStateException(); }));
            assertEquals("retry", reads.read("failure", () -> "retry"));
        } finally { release.countDown(); owner.join(3000); }
    }

    @Test public void interruptedWaiterDoesNotCancelOwner() throws Exception {
        AlphaPendingDisplayReads reads = new AlphaPendingDisplayReads();
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        FutureTask<String> one = new FutureTask<>(() -> reads.read("key", () -> {
            started.countDown(); release.await(3, TimeUnit.SECONDS); return "result"; }));
        FutureTask<Boolean> two = new FutureTask<>(() -> {
            try { reads.read("key", () -> "unexpected"); return false; }
            catch (InterruptedException expected) { return Thread.currentThread().isInterrupted(); }
        });
        Thread owner = new Thread(one), waiter = new Thread(two);
        try {
            owner.start(); assertTrue(started.await(3, TimeUnit.SECONDS));
            waiter.start(); awaitWaiting(waiter); waiter.interrupt();
            assertTrue(two.get(3, TimeUnit.SECONDS));
            release.countDown(); assertEquals("result", one.get(3, TimeUnit.SECONDS));
        } finally { release.countDown(); owner.join(3000); waiter.join(3000); }
    }
}