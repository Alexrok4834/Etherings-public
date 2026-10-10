package xyz.etherings.player.sync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;
import androidx.work.Configuration;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import androidx.work.NetworkType;
import androidx.work.testing.SynchronousExecutor;
import androidx.work.testing.WorkManagerTestInitHelper;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.List;

import xyz.etherings.player.auth.SessionStore;
import xyz.etherings.player.step.StepRecoveryReceiver;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class StepSyncSchedulerTest {
    private Context context;
    private WorkManager workManager;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        Configuration configuration = new Configuration.Builder()
                .setExecutor(new SynchronousExecutor())
                .build();
        WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration);
        workManager = WorkManager.getInstance(context);
    }

    @Test
    public void scheduleAllKeepsOneNetworkConstrainedWorkOfEachKind() throws Exception {
        StepSyncScheduler.scheduleAll(context);
        StepSyncScheduler.scheduleAll(context);

        List<WorkInfo> oneTime = workManager
                .getWorkInfosForUniqueWork(StepSyncScheduler.ONE_TIME_WORK_NAME)
                .get();
        List<WorkInfo> periodic = workManager
                .getWorkInfosForUniqueWork(StepSyncScheduler.PERIODIC_WORK_NAME)
                .get();

        assertEquals(1, oneTime.size());
        assertEquals(1, periodic.size());
        assertTrue(oneTime.get(0).getTags().contains(StepSyncWorker.class.getName()));
        assertTrue(periodic.get(0).getTags().contains(StepSyncWorker.class.getName()));
        assertEquals(NetworkType.CONNECTED, StepSyncScheduler.networkConstraints().getRequiredNetworkType());
    }

    @Test
    public void bootAndPackageReplacementKeepOneRecoverySchedule() throws Exception {
        new SessionStore(context).clear();
        StepRecoveryReceiver receiver = new StepRecoveryReceiver();

        receiver.onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
        receiver.onReceive(context, new Intent(Intent.ACTION_MY_PACKAGE_REPLACED));

        assertEquals(1, workManager.getWorkInfosForUniqueWork(StepSyncScheduler.ONE_TIME_WORK_NAME).get().size());
        assertEquals(1, workManager.getWorkInfosForUniqueWork(StepSyncScheduler.PERIODIC_WORK_NAME).get().size());
    }

    @Test
    public void continuationIsQueuedAfterCurrentDrainInsteadOfRetryingIt() throws Exception {
        StepSyncScheduler.enqueueOneTime(context);
        StepSyncScheduler.enqueueContinuation(context);

        List<WorkInfo> work = workManager
                .getWorkInfosForUniqueWork(StepSyncScheduler.ONE_TIME_WORK_NAME).get();
        assertEquals(2, work.size());
    }
}
