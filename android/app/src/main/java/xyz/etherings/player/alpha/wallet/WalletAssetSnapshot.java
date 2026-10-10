package xyz.etherings.player.alpha.wallet;

import java.math.BigInteger;

public final class WalletAssetSnapshot {
    public final String sol;
    public final String eru;

    private WalletAssetSnapshot(String sol, String eru) {
        this.sol = sol;
        this.eru = eru;
    }

    public static WalletAssetSnapshot from(String cluster, String walletAddress,
            String expectedAddress, String mint, String expectedMint,
            String solLamports, String eruBaseUnits) {
        if (!"devnet".equals(cluster) || expectedAddress == null ||
                !expectedAddress.equals(walletAddress) || !expectedMint.equals(mint)) {
            throw new IllegalArgumentException("Wallet asset identity mismatch");
        }
        return new WalletAssetSnapshot(units(solLamports), units(eruBaseUnits));
    }

    public static boolean covers(String rawBaseUnits, long requiredBaseUnits) {
        if (rawBaseUnits == null || !rawBaseUnits.matches("0|[1-9][0-9]*") ||
                requiredBaseUnits <= 0) throw new IllegalArgumentException("Invalid asset amount");
        return new BigInteger(rawBaseUnits).compareTo(BigInteger.valueOf(requiredBaseUnits)) >= 0;
    }

    private static String units(String raw) {
        if (raw == null || !raw.matches("0|[1-9][0-9]*")) {
            throw new IllegalArgumentException("Invalid wallet asset amount");
        }
        BigInteger[] parts = new BigInteger(raw).divideAndRemainder(BigInteger.valueOf(1_000_000_000L));
        if (parts[1].signum() == 0) return parts[0].toString();
        String fraction = String.format(java.util.Locale.ROOT, "%09d", parts[1].longValue());
        return parts[0] + "." + fraction.replaceFirst("0+$", "");
    }
}
