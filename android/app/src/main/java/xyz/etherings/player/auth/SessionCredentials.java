package xyz.etherings.player.auth;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.UUID;

public final class SessionCredentials {
    private final String accessToken;
    private final String refreshToken;
    private final String refreshTokenExpiresAt;
    private final String ownerId;
    private final String installationId;

    public SessionCredentials(
            String accessToken,
            String refreshToken,
            String refreshTokenExpiresAt,
            String ownerId,
            String installationId
    ) {
        this.accessToken = require(accessToken, "accessToken");
        this.refreshToken = require(refreshToken, "refreshToken");
        this.refreshTokenExpiresAt = requireInstant(refreshTokenExpiresAt);
        this.ownerId = requireUuid(ownerId, "ownerId");
        this.installationId = requireUuid(installationId, "installationId");
    }

    public String accessToken() {
        return accessToken;
    }

    public String refreshToken() {
        return refreshToken;
    }

    public String refreshTokenExpiresAt() {
        return refreshTokenExpiresAt;
    }

    public String ownerId() {
        return ownerId;
    }

    public String installationId() {
        return installationId;
    }

    public SessionCredentials rotate(String nextAccessToken, String nextRefreshToken, String nextExpiresAt) {
        return new SessionCredentials(nextAccessToken, nextRefreshToken, nextExpiresAt, ownerId, installationId);
    }

    private static String require(String value, String name) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }

    private static String requireUuid(String value, String name) {
        String required = require(value, name);
        try {
            return UUID.fromString(required).toString();
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(name + " must be a UUID", error);
        }
    }

    private static String requireInstant(String value) {
        String required = require(value, "refreshTokenExpiresAt");
        try {
            Instant.parse(required);
            return required;
        } catch (DateTimeParseException error) {
            throw new IllegalArgumentException("refreshTokenExpiresAt must be an ISO instant", error);
        }
    }
}
