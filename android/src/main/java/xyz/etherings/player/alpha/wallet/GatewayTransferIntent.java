package xyz.etherings.player.alpha.wallet;

/** Expected transaction intent from a future verified Alpha account flow. */
public final class GatewayTransferIntent {
    public final String authority;
    public final String source;
    public final String destination;
    public final String treasury;
    public final String config;
    public final String replay;
    public final String mint;
    public final String meta;
    public final String sysvar;
    public final String tokenProgram;
    public final String hook;
    public final String systemProgram;
    public final String gateway;
    public final long amount;
    public final long nonce;
    public final long expiry;

    public GatewayTransferIntent(String authority, String source, String destination,
            String treasury, String config, String replay, String mint, String meta,
            String sysvar, String tokenProgram, String hook, String systemProgram,
            String gateway, long amount, long nonce, long expiry) {
        this.authority = authority;
        this.source = source;
        this.destination = destination;
        this.treasury = treasury;
        this.config = config;
        this.replay = replay;
        this.mint = mint;
        this.meta = meta;
        this.sysvar = sysvar;
        this.tokenProgram = tokenProgram;
        this.hook = hook;
        this.systemProgram = systemProgram;
        this.gateway = gateway;
        if (amount <= 0 || nonce < 0 || expiry <= 0) {
            throw new IllegalArgumentException("invalid Gateway intent values");
        }
        this.amount = amount;
        this.nonce = nonce;
        this.expiry = expiry;
    }
}
