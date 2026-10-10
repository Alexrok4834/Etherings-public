package xyz.etherings.player.raffle;

public enum RafflePendingDrawState {
    SUBMITTING,
    UNCERTAIN,
    COMPLETED_UNREVEALED,
    REVEALED,
    TERMINAL_REJECTED
}
