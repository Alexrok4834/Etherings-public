package xyz.etherings.player.sync;

import android.content.Context;
import org.json.JSONObject;
import java.time.LocalDate;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.AlphaSessionStore;
import xyz.etherings.player.alpha.AlphaStepBatchAccess;
import xyz.etherings.player.alpha.AlphaAuthApi;
import xyz.etherings.player.api.ApiClient;
import xyz.etherings.player.api.ApiConfig;
import xyz.etherings.player.api.EtheringsApi;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.SessionStore;
import xyz.etherings.player.auth.SessionCredentials;
import xyz.etherings.player.step.StepRoomBootstrapper;
import xyz.etherings.player.step.StepDisplaySnapshotStore;
import xyz.etherings.player.step.RoomStepCounterStore;

import java.security.GeneralSecurityException;

public final class StepSyncWorker extends Worker {
    public StepSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        if (BuildConfig.IS_ALPHA_DEV) {
            return doAlphaWork();
        }
        ApiConfig config = ApiConfig.fromBuildConfig();
        if (!config.isSecureMobileSessionTransport()) {
            return Result.success();
        }

        Context context = getApplicationContext();
        SyncStatusStore statusStore = new SyncStatusStore(context);
        EtheringsDatabase database = EtheringsDatabase.open(context);
        StepRoomBootstrapper.bootstrap(context, database, System.currentTimeMillis());
        EtheringsApi api = new EtheringsApi(new ApiClient(config), config);
        SessionStore sessionStore = new SessionStore(context);
        SessionCredentials credentials;
        try {
            credentials = sessionStore.getCredentials();
        } catch (GeneralSecurityException error) {
            sessionStore.clear();
            return Result.success();
        }
        if (credentials == null) {
            return Result.success();
        }
        long attemptAtMs = System.currentTimeMillis();
        statusStore.markAttempt(credentials.ownerId(), false, attemptAtMs);
        new RoomStepCounterStore(database).snapshotAndCloseAgedBatch(
                credentials.ownerId(),
                attemptAtMs
        );
        StepBatchDeliveryEngine engine = new StepBatchDeliveryEngine(
                database.stepSyncDao(),
                api,
                new AuthenticatedSession(api, sessionStore),
                sessionStore,
                System::currentTimeMillis,
                this::isStopped
        );
        StepBatchDeliveryEngine.Outcome outcome = engine.drain();
        if (outcome == StepBatchDeliveryEngine.Outcome.AUTH_REQUIRED) {
            statusStore.markAttempt(credentials.ownerId(), true, System.currentTimeMillis());
        }
        new RoomSyncStatusPublisher(database, statusStore).publish(credentials.ownerId());
        if (outcome == StepBatchDeliveryEngine.Outcome.RETRY
                || outcome == StepBatchDeliveryEngine.Outcome.MORE_PENDING) {
            return Result.retry();
        }
        return Result.success();
    }

    private Result doAlphaWork() {
        Context context = getApplicationContext();
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        AlphaSessionStore.VerifiedSession verified = sessions.verified();
        if (verified == null) return Result.success();

        ApiConfig config = new ApiConfig(BuildConfig.ALPHA_DEV_API_BASE_URL);
        if (!config.isSecureMobileSessionTransport()) return Result.success();
        EtheringsDatabase database = EtheringsDatabase.open(context);
        String installationId = StepRoomBootstrapper.bootstrap(
                context, database, System.currentTimeMillis()).installationId();
        SyncStatusStore statusStore = new SyncStatusStore(context);
        long attemptAtMs = System.currentTimeMillis();
        statusStore.markAttempt(verified.ownerId(), false, attemptAtMs);
        new RoomStepCounterStore(database).snapshotAndCloseAgedBatch(verified.ownerId(), attemptAtMs);

        EtheringsApi api = new EtheringsApi(new ApiClient(config), config);
        StepBatchDeliveryEngine engine = new StepBatchDeliveryEngine(
                database.stepSyncDao(), api,
                new AlphaStepBatchAccess(sessions, installationId, context,
                        BuildConfig.ALPHA_DEV_API_BASE_URL),
                System::currentTimeMillis, this::isStopped);
        StepBatchDeliveryEngine.Outcome outcome = engine.drain();
        if (outcome == StepBatchDeliveryEngine.Outcome.AUTH_REQUIRED) {
            statusStore.markAttempt(verified.ownerId(), true, System.currentTimeMillis());
        } else {
            refreshAlphaStepCap(context, sessions, verified);
        }
        new RoomSyncStatusPublisher(database, statusStore).publish(verified.ownerId());
        if (outcome == StepBatchDeliveryEngine.Outcome.MORE_PENDING) {
            StepSyncScheduler.enqueueContinuation(context);
            return Result.success();
        }
        return outcome == StepBatchDeliveryEngine.Outcome.RETRY
                ? Result.retry() : Result.success();
    }

    private static void refreshAlphaStepCap(Context context, AlphaSessionStore sessions,
            AlphaSessionStore.VerifiedSession verified) {
        String date = LocalDate.now().toString();
        Integer cap = null;
        try {
            AlphaAuthApi.Result response = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                    .get("/m2e/today?date=" + date, verified.token());
            if (response.status != 200) throw new IllegalStateException("Alpha cap unavailable");
            JSONObject body = response.body;
            Object raw = body.opt("dailyStepCap");
            if (date.equals(body.optString("date")) && raw instanceof Integer
                    && (Integer) raw > 0) cap = (Integer) raw;
        } catch (Exception ignored) {
            // UNKNOWN/offline capacity cannot be presented as current.
        }
        AlphaSessionStore.VerifiedSession current = sessions.verified();
        if (current != null && verified.ownerId().equals(current.ownerId())
                && verified.lineage().equals(current.lineage())
                && date.equals(LocalDate.now().toString()))
            new StepDisplaySnapshotStore(context).saveServerDailyStepCap(
                    current.ownerId(), date, cap);
    }
}
