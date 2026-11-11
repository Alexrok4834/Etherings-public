package xyz.etherings.player.alpha;

import java.util.concurrent.Callable;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

/** One fresh read-only recovery after invalidation; never accepts a crossed revision. */
public final class AlphaDisplayReadRecovery {
    private AlphaDisplayReadRecovery() { }
    public static final class Result<T> {
        public final T value;
        public final long revision;
        private Result(T value, long revision) { this.value = value; this.revision = revision; }
    }
    public static <T> Result<T> read(LongSupplier revision, BooleanSupplier sameSession,
            Callable<T> initial, Callable<T> recovery) throws Exception {
        long start = revision.getAsLong();
        T value = null;
        Exception failure = null;
        try { value = initial.call(); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw interrupted; }
        catch (Exception error) { failure = error; }
        if (!sameSession.getAsBoolean()) throw new IllegalStateException("Display session changed");
        if (revision.getAsLong() == start) {
            if (failure != null) throw failure;
            return new Result<>(value, start);
        }
        start = revision.getAsLong();
        value = recovery.call();
        if (!sameSession.getAsBoolean() || revision.getAsLong() != start)
            throw new IllegalStateException("Display changed during recovery");
        return new Result<>(value, start);
    }
}
