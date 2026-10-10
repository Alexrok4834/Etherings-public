package xyz.etherings.player.ring;

import java.util.UUID;
import java.util.function.Supplier;

public final class CopperMutationRetryKey {
    private final Supplier<String> generator;
    private String signature;
    private String key;

    public CopperMutationRetryKey() {
        this(() -> UUID.randomUUID().toString());
    }

    CopperMutationRetryKey(Supplier<String> generator) {
        this.generator = generator;
    }

    public String keyFor(String requestSignature) {
        if (requestSignature == null || requestSignature.isEmpty()) {
            throw new IllegalArgumentException("Request signature is required");
        }
        if (!requestSignature.equals(signature)) {
            signature = requestSignature;
            key = generator.get();
        }
        return key;
    }

    public void clear() {
        signature = null;
        key = null;
    }
}
