package xyz.etherings.player.alpha;

import java.net.URI;

/** Exact build-approved HTTPS ingress for both AlphaDev and public Alpha. */
public final class AlphaEndpointPolicy {
    private AlphaEndpointPolicy() { }

    public static void requireApi(String candidate, String configured) {
        if (candidate == null || !candidate.equals(configured))
            throw new IllegalArgumentException("Unapproved Alpha API endpoint");
        try {
            URI uri = URI.create(configured);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null ||
                    uri.getHost().isEmpty() || uri.getPort() != -1 ||
                    uri.getRawUserInfo() != null || uri.getRawQuery() != null ||
                    uri.getRawFragment() != null || !"".equals(uri.getRawPath()))
                throw new IllegalArgumentException("Unapproved Alpha API endpoint");
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("Unapproved Alpha API endpoint", e);
        }
    }

    public static void requireDevnetRpc(String candidate, String configuredRpc,
            String configuredApi) {
        requireApi(configuredApi, configuredApi);
        if (candidate == null || !candidate.equals(configuredRpc) ||
                !candidate.equals(configuredApi + "/rpc/devnet"))
            throw new IllegalArgumentException("Unapproved Alpha Devnet RPC endpoint");
    }
}
