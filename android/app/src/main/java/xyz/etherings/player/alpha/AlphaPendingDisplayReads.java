package xyz.etherings.player.alpha;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;

/** Shares only unfinished display reads. No executor, completed cache or disk storage. */
final class AlphaPendingDisplayReads {
    private final Map<String, FutureTask<String>> pending = new HashMap<>();

    String read(String key, Callable<String> load) throws Exception {
        FutureTask<String> task;
        boolean owner = false;
        synchronized (pending) {
            task = pending.get(key);
            if (task == null && pending.size() < 16) {
                task = new FutureTask<>(load);
                pending.put(key, task);
                owner = true;
            }
        }
        if (task == null) return load.call();
        try {
            if (owner) task.run();
            return task.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw error; // A waiting screen cannot cancel another screen's request.
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw new IllegalStateException("Display read failed");
        } finally {
            if (owner) synchronized (pending) {
                if (pending.get(key) == task) pending.remove(key);
            }
        }
    }
}