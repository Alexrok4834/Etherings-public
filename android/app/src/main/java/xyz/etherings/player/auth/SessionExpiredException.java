package xyz.etherings.player.auth;

public final class SessionExpiredException extends Exception {
    public SessionExpiredException(String message, Throwable cause) {
        super(message, cause);
    }

    public SessionExpiredException(String message) {
        super(message);
    }
}
