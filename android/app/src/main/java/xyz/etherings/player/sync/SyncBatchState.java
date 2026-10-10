package xyz.etherings.player.sync;

public enum SyncBatchState {
    OPEN,
    READY,
    IN_FLIGHT,
    HELD,
    ACKED,
    TERMINAL_REJECTED
}
