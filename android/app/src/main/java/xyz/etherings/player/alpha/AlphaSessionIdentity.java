package xyz.etherings.player.alpha;

final class AlphaSessionIdentity {
    private static final String TOKEN = "[a-f0-9]{64}";
    private static final String ACCOUNT_ID =
            "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

    final String token;
    final String accountId;
    final String refreshToken;
    final String refreshExpiresAt;
    final String installationId;
    final String lineage;

    private AlphaSessionIdentity(String token, String accountId, String refreshToken,
                                 String refreshExpiresAt, String installationId, String lineage) {
        this.token = token;
        this.accountId = accountId;
        this.refreshToken = refreshToken;
        this.refreshExpiresAt = refreshExpiresAt;
        this.installationId = installationId;
        this.lineage = lineage;
    }

    static AlphaSessionIdentity legacy(String token) {
        if (token == null || !token.matches(TOKEN)) throw new IllegalArgumentException("Invalid session");
        return new AlphaSessionIdentity(token, null, null, null, null, null);
    }

    static AlphaSessionIdentity verified(String token, String accountId) {
        legacy(token);
        if (accountId == null || !accountId.matches(ACCOUNT_ID))
            throw new IllegalArgumentException("Invalid Alpha account ID");
        return new AlphaSessionIdentity(token, accountId, null, null, null, token);
    }

    static AlphaSessionIdentity renewable(String token, String accountId, String refreshToken,
                                          String refreshExpiresAt, String installationId, String lineage) {
        verified(token, accountId);
        if (refreshToken == null || !refreshToken.matches("[A-Za-z0-9_-]{43}") ||
                refreshExpiresAt == null || installationId == null || lineage == null ||
                !installationId.matches(ACCOUNT_ID) || !lineage.matches(ACCOUNT_ID))
            throw new IllegalArgumentException("Invalid renewable Alpha session");
        try { java.time.Instant.parse(refreshExpiresAt); }
        catch (Exception error) { throw new IllegalArgumentException("Invalid refresh expiry", error); }
        return new AlphaSessionIdentity(token, accountId, refreshToken,
                refreshExpiresAt, installationId, lineage);
    }

    String encode() {
        if (refreshToken != null) return token + "\n" + accountId + "\n" + refreshToken + "\n" +
                refreshExpiresAt + "\n" + installationId + "\n" + lineage;
        return accountId == null ? token : token + "\n" + accountId;
    }

    static AlphaSessionIdentity decode(int version, String plaintext) {
        if (version == 1) return legacy(plaintext);
        if (version == 3 && plaintext != null) {
            String[] parts = plaintext.split("\\n", -1);
            if (parts.length != 6) throw new IllegalArgumentException("Invalid renewable session");
            return renewable(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
        }
        if (version != 2 || plaintext == null) throw new IllegalArgumentException("Invalid session version");
        int separator = plaintext.indexOf('\n');
        if (separator != 64 || plaintext.indexOf('\n', separator + 1) != -1)
            throw new IllegalArgumentException("Invalid verified session");
        return verified(plaintext.substring(0, separator), plaintext.substring(separator + 1));
    }
}
