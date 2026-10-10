package xyz.etherings.alpha;

final class IntentExpiry {
    static void requireCluster(String selected, String issued) {
        if (!"devnet".equals(selected) || !selected.equals(issued))
            throw new IllegalArgumentException("ERU intent cluster mismatch");
    }

    static void requireDevnet(long confirmedSlot, long expirySlot, long nonce) {
        if (confirmedSlot < 0 || expirySlot < confirmedSlot ||
                expirySlot - confirmedSlot > 600 || nonce <= 0)
            throw new IllegalArgumentException("ERU intent expired or outside Devnet window");
    }
}
