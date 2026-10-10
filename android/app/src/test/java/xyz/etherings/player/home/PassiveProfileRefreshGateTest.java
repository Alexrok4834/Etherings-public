package xyz.etherings.player.home;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PassiveProfileRefreshGateTest {
    @Test
    public void refreshesOnceWhenSuccessfulSyncAdvances() {
        PassiveProfileRefreshGate gate = new PassiveProfileRefreshGate();

        gate.observe(100L);
        assertTrue(gate.beginIfAdvanced(200L));
        assertFalse(gate.beginIfAdvanced(200L));
        assertFalse(gate.beginIfAdvanced(300L));

        gate.finish();
        assertTrue(gate.beginIfAdvanced(300L));
    }

    @Test
    public void initialSnapshotOnlyEstablishesBaseline() {
        PassiveProfileRefreshGate gate = new PassiveProfileRefreshGate();

        assertFalse(gate.beginIfAdvanced(100L));
        assertFalse(gate.beginIfAdvanced(100L));
        assertTrue(gate.beginIfAdvanced(101L));
    }

    @Test
    public void firstSuccessfulSyncRefreshesAfterExplicitZeroBaseline() {
        PassiveProfileRefreshGate gate = new PassiveProfileRefreshGate();

        gate.observe(0L);

        assertTrue(gate.beginIfAdvanced(100L));
    }
}
