package xyz.etherings.player.step;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.time.LocalDate;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class StepDisplaySnapshotStoreTest {
    private StepDisplaySnapshotStore store;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("etherings_room_step_display_v1", Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        store = new StepDisplaySnapshotStore(context);
    }

    @Test
    public void returnsSnapshotOnlyForItsOwner() {
        String firstOwner = UUID.randomUUID().toString();
        String secondOwner = UUID.randomUUID().toString();
        store.save(firstOwner, new StepCounterSnapshot(
                240L,
                120L,
                40L,
                1000L,
                5000L,
                4,
                2000L,
                "2026-08-11"
        ));

        assertEquals(120L, store.snapshot(firstOwner).dailySteps());
        assertEquals(0L, store.snapshot(secondOwner).dailySteps());
    }

    @Test
    public void notifiesOncePerSnapshotAndStopsWithActivityLifecycle() {
        AtomicInteger notifications = new AtomicInteger();
        store.startListening(notifications::incrementAndGet);

        store.save(UUID.randomUUID().toString(), snapshot(10L));
        assertEquals(1, notifications.get());

        store.stopListening();
        store.save(UUID.randomUUID().toString(), snapshot(20L));
        assertEquals(1, notifications.get());
    }

    @Test
    public void retainsServerCapOnlyForItsAuthenticatedOwner() {
        String firstOwner = UUID.randomUUID().toString();
        String secondOwner = UUID.randomUUID().toString();

        store.saveServerDailyStepCap(firstOwner, 6000);

        assertEquals(Integer.valueOf(6000), store.serverDailyStepCap(firstOwner));
        assertEquals(null, store.serverDailyStepCap(secondOwner));
        store.saveServerDailyStepCap(firstOwner, null);
        assertEquals(null, store.serverDailyStepCap(firstOwner));
    }

    @Test
    public void alphaCapNotifiesServiceAndNeverUsesPreviousDay() {
        String owner = UUID.randomUUID().toString();
        AtomicInteger notifications = new AtomicInteger();
        store.startCapListening(notifications::incrementAndGet);
        store.saveServerDailyStepCap(owner, LocalDate.now().minusDays(1).toString(), 6000);
        assertEquals(null, store.serverDailyStepCap(owner));
        store.saveServerDailyStepCap(owner, LocalDate.now().toString(), 6000);
        assertEquals(Integer.valueOf(6000), store.serverDailyStepCap(owner));
        assertTrue(notifications.get() > 0);
        store.stopCapListening();
        int before = notifications.get();
        store.saveServerDailyStepCap(owner, null);
        assertEquals(before, notifications.get());
    }

    private StepCounterSnapshot snapshot(long dailySteps) {
        return new StepCounterSnapshot(
                dailySteps,
                dailySteps,
                dailySteps,
                1000L,
                5000L,
                1,
                2000L,
                "2026-08-11"
        );
    }
}
