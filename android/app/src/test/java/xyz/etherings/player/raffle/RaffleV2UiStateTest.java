package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import xyz.etherings.player.BuildConfig;

public final class RaffleV2UiStateTest {
    @Test
    public void deviceAcceptanceDebugBuildEnablesPaidDraw() {
        assertTrue(BuildConfig.RAFFLE_V2_PAID_DRAW_ENABLED);
    }

    @Test
    public void paidGateClosesBothNewAndRecoveryCommands() {
        RaffleV2UiState ready = RaffleV2UiState.from(null);
        RaffleV2UiState recovery = RaffleV2UiState.from(entity(RafflePendingDrawState.UNCERTAIN));

        assertFalse(ready.canSubmit(false));
        assertFalse(recovery.canSubmit(false));
        assertTrue(ready.canSubmit(true));
        assertTrue(recovery.canSubmit(true));
    }

    @Test
    public void completedStatesCannotCreateAnotherOperation() {
        RaffleV2UiState unrevealed = RaffleV2UiState.from(
                entity(RafflePendingDrawState.COMPLETED_UNREVEALED));
        RaffleV2UiState revealed = RaffleV2UiState.from(entity(RafflePendingDrawState.REVEALED));

        assertEquals(RaffleV2UiState.Kind.REVEAL_REQUIRED, unrevealed.kind());
        assertFalse(unrevealed.canSubmit(true));
        assertFalse(unrevealed.canDismiss());
        assertTrue(revealed.canDismiss());
    }

    @Test
    public void terminalRejectionRequiresAcknowledgementNotResubmission() {
        RaffleV2UiState state = RaffleV2UiState.from(
                entity(RafflePendingDrawState.TERMINAL_REJECTED));

        assertEquals(RaffleV2UiState.Kind.TERMINAL_REJECTED, state.kind());
        assertFalse(state.canSubmit(true));
        assertTrue(state.canDismiss());
    }

    private static RafflePendingDrawEntity entity(RafflePendingDrawState state) {
        return new RafflePendingDrawEntity(
                "11111111-1111-4111-8111-111111111111",
                "raffle-v2",
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333333",
                state,
                state == RafflePendingDrawState.COMPLETED_UNREVEALED
                        || state == RafflePendingDrawState.REVEALED ? "{}" : null,
                state == RafflePendingDrawState.TERMINAL_REJECTED
                        ? "RAFFLE_DAILY_LIMIT_REACHED" : null,
                1L,
                1L
        );
    }
}
