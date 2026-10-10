package xyz.etherings.player.raffle;

public final class RaffleV2UiState {
    public enum Kind {
        READY,
        RECOVERY_REQUIRED,
        REVEAL_REQUIRED,
        REVEALED,
        TERMINAL_REJECTED
    }

    private final Kind kind;

    private RaffleV2UiState(Kind kind) {
        this.kind = kind;
    }

    public static RaffleV2UiState from(RafflePendingDrawEntity pending) {
        if (pending == null) return new RaffleV2UiState(Kind.READY);
        switch (pending.state) {
            case SUBMITTING:
            case UNCERTAIN:
                return new RaffleV2UiState(Kind.RECOVERY_REQUIRED);
            case COMPLETED_UNREVEALED:
                return new RaffleV2UiState(Kind.REVEAL_REQUIRED);
            case REVEALED:
                return new RaffleV2UiState(Kind.REVEALED);
            case TERMINAL_REJECTED:
                return new RaffleV2UiState(Kind.TERMINAL_REJECTED);
            default:
                throw new IllegalStateException("Unsupported pending Draw state");
        }
    }

    public Kind kind() { return kind; }

    public boolean canSubmit(boolean paidDrawEnabled) {
        return paidDrawEnabled && (kind == Kind.READY || kind == Kind.RECOVERY_REQUIRED);
    }

    public boolean canDismiss() {
        return kind == Kind.REVEALED || kind == Kind.TERMINAL_REJECTED;
    }
}
