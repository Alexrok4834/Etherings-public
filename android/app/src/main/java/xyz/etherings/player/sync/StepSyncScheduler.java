package xyz.etherings.player.sync;

import android.content.Context;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

public final class StepSyncScheduler {
    static final String ONE_TIME_WORK_NAME = "etherings-step-sync-now-v2";
    static final String PERIODIC_WORK_NAME = "etherings-step-sync-periodic-v1";

    private StepSyncScheduler() {
    }

    public static void enqueueOneTime(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(StepSyncWorker.class)
                .setConstraints(networkConstraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30L, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
                ONE_TIME_WORK_NAME,
                ExistingWorkPolicy.KEEP,
                request
        );
    }

    /** Continue a healthy bounded drain without treating remaining work as a failed attempt. */
    public static void enqueueContinuation(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(StepSyncWorker.class)
                .setConstraints(networkConstraints())
                .setInitialDelay(10L, TimeUnit.SECONDS)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30L, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
                ONE_TIME_WORK_NAME,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
                request
        );
    }

    public static void ensurePeriodic(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                StepSyncWorker.class,
                15L,
                TimeUnit.MINUTES
        )
                .setConstraints(networkConstraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30L, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
        );
    }

    public static void scheduleAll(Context context) {
        ensurePeriodic(context);
        enqueueOneTime(context);
    }

    static Constraints networkConstraints() {
        return new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
    }
}
