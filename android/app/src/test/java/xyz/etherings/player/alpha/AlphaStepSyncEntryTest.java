package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.work.ListenableWorker;
import androidx.work.testing.TestListenableWorkerBuilder;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.step.StepTrackingRecovery;
import xyz.etherings.player.sync.StepSyncWorker;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AlphaStepSyncEntryTest {
    @Test public void signedOutAlphaDoesNotStartTrackingOrDelivery() {
        assertTrue(BuildConfig.IS_ALPHA_DEV);
        Context context = ApplicationProvider.getApplicationContext();
        new AlphaSessionStore(context).clear();

        assertFalse(StepTrackingRecovery.isEligible(context));
        StepSyncWorker worker = TestListenableWorkerBuilder.from(context, StepSyncWorker.class).build();
        assertEquals(ListenableWorker.Result.success(), worker.doWork());
    }
}
