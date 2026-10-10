package xyz.etherings.player.api;

public final class ApiException extends Exception {
    private final int statusCode;
    private final String responseBody;

    public ApiException(int statusCode, String responseBody) {
        super("API request failed with HTTP " + statusCode);
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }

    public int statusCode() {
        return statusCode;
    }

    public String responseBody() {
        return responseBody;
    }
}