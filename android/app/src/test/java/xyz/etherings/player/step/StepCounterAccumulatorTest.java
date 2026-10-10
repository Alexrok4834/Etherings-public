package xyz.etherings.player.step;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class StepCounterAccumulatorTest {
    @Test
    public void firstReadingEstablishesRawEpochWithoutInventingSteps() {
        StepCounterAccumulator.State initial = new StepCounterAccumulator.State(0, 0, 0, 0, false, "2026-07-10");

        StepCounterAccumulator.State next = StepCounterAccumulator.record(initial, 5000, "2026-07-10");

        assertEquals(0, next.totalSteps);
        assertEquals(0, next.dailySteps);
        assertEquals(0, next.rewardWindowSteps);
        assertEquals(5000, next.lastRawCounter);
        assertTrue(next.rawCounterInitialized);
    }

    @Test
    public void normalRawIncreaseAddsDeltaToEveryCounter() {
        StepCounterAccumulator.State initial = new StepCounterAccumulator.State(100, 80, 60, 5000, true, "2026-07-10");

        StepCounterAccumulator.State next = StepCounterAccumulator.record(initial, 5075, "2026-07-10");

        assertEquals(175, next.totalSteps);
        assertEquals(155, next.dailySteps);
        assertEquals(135, next.rewardWindowSteps);
    }

    @Test
    public void lowerRawCounterEstablishesNewEpochWithoutInventingUnobservedSteps() {
        StepCounterAccumulator.State beforeReboot = new StepCounterAccumulator.State(3200, 3100, 3075, 12000, true, "2026-07-10");

        StepCounterAccumulator.State afterReboot = StepCounterAccumulator.record(beforeReboot, 42, "2026-07-10");

        assertEquals(3200, afterReboot.totalSteps);
        assertEquals(3100, afterReboot.dailySteps);
        assertEquals(3075, afterReboot.rewardWindowSteps);
        assertEquals(42, afterReboot.lastRawCounter);
    }

    @Test
    public void dayRolloverResetsDailyOnlyAndKeepsRewardWindow() {
        StepCounterAccumulator.State yesterday = new StepCounterAccumulator.State(3200, 3100, 3075, 12000, true, "2026-07-10");

        StepCounterAccumulator.State today = StepCounterAccumulator.record(yesterday, 12025, "2026-07-11");

        assertEquals(3225, today.totalSteps);
        assertEquals(25, today.dailySteps);
        assertEquals(3100, today.rewardWindowSteps);
        assertEquals("2026-07-11", today.dailyDate);
    }

    @Test
    public void snapshotDayRolloverKeepsTotalAndRewardWindow() {
        StepCounterAccumulator.State yesterday = new StepCounterAccumulator.State(3200, 3100, 3075, 12000, true, "2026-07-10");

        StepCounterAccumulator.State today = StepCounterAccumulator.rollDay(yesterday, "2026-07-11");

        assertEquals(3200, today.totalSteps);
        assertEquals(0, today.dailySteps);
        assertEquals(3075, today.rewardWindowSteps);
    }

    @Test
    public void rewardResetClearsOnlyClaimableWindow() {
        StepCounterAccumulator.State current = new StepCounterAccumulator.State(3200, 3100, 3075, 12000, true, "2026-07-10");

        StepCounterAccumulator.State reset = current.resetRewardWindow();

        assertEquals(3200, reset.totalSteps);
        assertEquals(3100, reset.dailySteps);
        assertEquals(0, reset.rewardWindowSteps);
    }

    @Test
    public void legacyMigrationPreservesExistingDerivedCounters() {
        StepCounterAccumulator.State migrated = StepCounterAccumulator.fromLegacy(
                12000,
                8000,
                9000,
                8925,
                true,
                "2026-07-10"
        );

        assertEquals(4000, migrated.totalSteps);
        assertEquals(3000, migrated.dailySteps);
        assertEquals(3075, migrated.rewardWindowSteps);
        assertEquals(12000, migrated.lastRawCounter);
        assertTrue(migrated.rawCounterInitialized);
    }

    @Test
    public void emptyLegacyStateRemainsUninitialized() {
        StepCounterAccumulator.State migrated = StepCounterAccumulator.fromLegacy(0, 0, 0, 0, false, "2026-07-10");

        assertEquals(0, migrated.rewardWindowSteps);
        assertFalse(migrated.rawCounterInitialized);
    }
}
