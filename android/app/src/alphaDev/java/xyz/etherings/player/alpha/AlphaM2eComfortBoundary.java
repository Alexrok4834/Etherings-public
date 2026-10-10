package xyz.etherings.player.alpha;

import android.content.Context;

import xyz.etherings.player.step.RoomStepCounterStore;
import xyz.etherings.player.sync.EtheringsDatabase;

/** Keeps already observed steps in their own durable outbox batch before mutation. */
final class AlphaM2eComfortBoundary {
    private AlphaM2eComfortBoundary() { }

    static void close(Context context) {
        AlphaSessionStore.VerifiedSession session = new AlphaSessionStore(context).verified();
        if (session == null) throw new IllegalStateException("Alpha session unavailable");
        new RoomStepCounterStore(EtheringsDatabase.open(context))
                .closeOpenBatchAtComfortBoundary(session.ownerId(), System.currentTimeMillis());
    }
}
