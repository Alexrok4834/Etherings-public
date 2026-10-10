package xyz.etherings.player.auth;

public final class LoginUiState {
    public enum Status {
        SIGNED_OUT,
        SUBMITTING,
        SIGNED_IN,
        INVALID_CREDENTIALS,
        BACKEND_OFFLINE,
        SESSION_EXPIRED,
        ERROR
    }

    private final Status status;
    private final String username;
    private final String errorMessage;

    private LoginUiState(Status status, String username, String errorMessage) {
        this.status = status;
        this.username = username == null ? "" : username;
        this.errorMessage = errorMessage;
    }

    public static LoginUiState signedOut() {
        return new LoginUiState(Status.SIGNED_OUT, "", null);
    }

    public static LoginUiState submitting(String username) {
        return new LoginUiState(Status.SUBMITTING, username, null);
    }

    public static LoginUiState signedIn(String username) {
        return new LoginUiState(Status.SIGNED_IN, username, null);
    }

    public static LoginUiState invalidCredentials(String username) {
        return new LoginUiState(Status.INVALID_CREDENTIALS, username, "Invalid username or password");
    }

    public static LoginUiState backendOffline(String username) {
        return new LoginUiState(Status.BACKEND_OFFLINE, username, "Backend is unavailable");
    }

    public static LoginUiState sessionExpired(String username) {
        return new LoginUiState(Status.SESSION_EXPIRED, username, "Session expired. Sign in again.");
    }

    public static LoginUiState error(String username, String message) {
        return new LoginUiState(Status.ERROR, username, message == null || message.trim().isEmpty() ? "Unexpected error" : message);
    }

    public Status status() {
        return status;
    }

    public String username() {
        return username;
    }

    public String errorMessage() {
        return errorMessage;
    }

    public boolean isBusy() {
        return status == Status.SUBMITTING;
    }

    public boolean isAuthenticated() {
        return status == Status.SIGNED_IN;
    }

    public boolean hasError() {
        return errorMessage != null;
    }
}