package xyz.etherings.alpha;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

final class BindingChallenge {
    final String nonce;
    final String walletAddress;
    final String environment;
    final String accountId;
    final long expiresAtMs;
    private final byte[] message;

    private BindingChallenge(String nonce, String walletAddress, String environment,
            String accountId, long expiresAtMs, byte[] message) {
        this.nonce = nonce;
        this.walletAddress = walletAddress;
        this.environment = environment;
        this.accountId = accountId;
        this.expiresAtMs = expiresAtMs;
        this.message = Arrays.copyOf(message, message.length);
    }

    byte[] message() { return Arrays.copyOf(message, message.length); }

    static BindingChallenge decode(String base64, String responseNonce, long responseExpiresAtMs,
            String expectedAccount,
            String expectedWallet, String expectedEnvironment, long nowMs) throws Exception {
        byte[] bytes = Base64.getDecoder().decode(base64);
        if (bytes.length > 512 || !Base64.getEncoder().encodeToString(bytes).equals(base64))
            throw new IllegalArgumentException("Noncanonical challenge encoding");
        for (byte value : bytes) {
            int c = value & 255;
            if (c != 10 && (c < 32 || c > 126))
                throw new IllegalArgumentException("Non-ASCII challenge");
        }
        String[] lines = new String(bytes, StandardCharsets.US_ASCII).split("\n", -1);
        if (lines.length != 9 || !lines[8].isEmpty() ||
                !lines[0].equals("EtheRings Alpha wallet binding") || !lines[1].equals("version=1"))
            throw new IllegalArgumentException("Unknown binding challenge");
        String account = field(lines[2], "account=");
        String wallet = field(lines[3], "wallet=");
        String environment = field(lines[4], "environment=");
        String nonce = field(lines[5], "nonce=");
        String issuedText = field(lines[6], "issued_at_ms=");
        String expiresText = field(lines[7], "expires_at_ms=");
        if (!account.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") ||
                !wallet.matches("[1-9A-HJ-NP-Za-km-z]{32,44}") ||
                !environment.matches("[a-z][a-z0-9-]{2,31}") ||
                !nonce.matches("[a-f0-9]{64}") ||
                !issuedText.matches("[0-9]{13}") || !expiresText.matches("[0-9]{13}"))
            throw new IllegalArgumentException("Malformed binding challenge");
        long issued = Long.parseLong(issuedText);
        long expires = Long.parseLong(expiresText);
        if (!account.equals(expectedAccount) || !wallet.equals(expectedWallet) ||
                !environment.equals(expectedEnvironment) || !nonce.equals(responseNonce) ||
                expires != responseExpiresAtMs || issued > nowMs + 120_000 ||
                expires <= nowMs || expires <= issued || expires - issued != 600_000)
            throw new IllegalArgumentException("Binding intent mismatch or expired");
        byte[] canonical = ("EtheRings Alpha wallet binding\nversion=1\naccount=" + account +
                "\nwallet=" + wallet + "\nenvironment=" + environment + "\nnonce=" + nonce +
                "\nissued_at_ms=" + issuedText + "\nexpires_at_ms=" + expiresText + "\n")
                .getBytes(StandardCharsets.US_ASCII);
        if (!Arrays.equals(canonical, bytes))
            throw new IllegalArgumentException("Noncanonical binding challenge");
        return new BindingChallenge(nonce, wallet, environment, account, expires, bytes);
    }

    private static String field(String line, String prefix) {
        if (!line.startsWith(prefix)) throw new IllegalArgumentException("Unexpected challenge field");
        return line.substring(prefix.length());
    }
}
