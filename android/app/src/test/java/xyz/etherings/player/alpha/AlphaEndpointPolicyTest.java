package xyz.etherings.player.alpha;

import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class AlphaEndpointPolicyTest {
    @Test public void acceptsExactConfiguredDevAndPublicIngress() {
        for (String api : new String[] {
                "https://alpha-dev.example.invalid", "https://api.etherings.xyz" }) {
            AlphaEndpointPolicy.requireApi(api, api);
            AlphaEndpointPolicy.requireDevnetRpc(api + "/rpc/devnet",
                    api + "/rpc/devnet", api);
        }
    }

    @Test public void rejectsCrossEnvironmentAndInsecureIngress() {
        assertThrows(IllegalArgumentException.class, () -> AlphaEndpointPolicy.requireApi(
                "https://alpha-dev.example.invalid", "https://api.etherings.xyz"));
        assertThrows(IllegalArgumentException.class, () -> AlphaEndpointPolicy.requireApi(
                "http://api.etherings.xyz", "http://api.etherings.xyz"));
        assertThrows(IllegalArgumentException.class, () -> AlphaEndpointPolicy.requireApi(
                "https://api.etherings.xyz/other", "https://api.etherings.xyz/other"));
        assertThrows(IllegalArgumentException.class, () -> AlphaEndpointPolicy.requireDevnetRpc(
                "https://alpha-dev.example.invalid/rpc/devnet",
                "https://api.etherings.xyz/rpc/devnet", "https://api.etherings.xyz"));
    }
}
