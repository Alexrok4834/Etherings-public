package xyz.etherings.player.auth;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.Locale;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.step.RoomLegacyWindowRecovery;

public final class LoginSessionService {
    private final LoginApi api;
    private final SessionCredentialStore sessionStore;
    private final InstallationIdProvider installationIdProvider;
    private final AuthenticatedSession authenticatedSession;
    private final RoomLegacyWindowRecovery legacyWindowRecovery;

    public LoginSessionService(
            LoginApi api,
            SessionCredentialStore sessionStore,
            InstallationIdProvider installationIdProvider,
            AuthenticatedSession authenticatedSession
    ) {
        this(api, sessionStore, installationIdProvider, authenticatedSession, null);
    }

    public LoginSessionService(
            LoginApi api,
            SessionCredentialStore sessionStore,
            InstallationIdProvider installationIdProvider,
            AuthenticatedSession authenticatedSession,
            RoomLegacyWindowRecovery legacyWindowRecovery
    ) {
        this.api = api;
        this.sessionStore = sessionStore;
        this.installationIdProvider = installationIdProvider;
        this.authenticatedSession = authenticatedSession;
        this.legacyWindowRecovery = legacyWindowRecovery;
    }

    public LoginUiState login(String username, String password) {
        String normalizedUsername = normalizeUsername(username);

        if (normalizedUsername.isEmpty() || password == null || password.isEmpty()) {
            return LoginUiState.invalidCredentials(normalizedUsername);
        }

        try {
            String installationId = installationIdProvider.installationId();
            JSONObject response = api.mobilePasswordLogin(normalizedUsername, password, installationId);
            return saveSession(response, normalizedUsername, installationId);
        } catch (ApiException error) {
            sessionStore.clear();
            if (error.statusCode() == 401) {
                return LoginUiState.invalidCredentials(normalizedUsername);
            }
            return LoginUiState.error(normalizedUsername, "Login failed with HTTP " + error.statusCode());
        } catch (IOException error) {
            return LoginUiState.backendOffline(normalizedUsername);
        } catch (JSONException | GeneralSecurityException | IllegalArgumentException | IllegalStateException error) {
            sessionStore.clear();
            return LoginUiState.error(normalizedUsername, "Could not save login session");
        }
    }

    public LoginUiState register(String username, String password, String passwordConfirmation, String displayName) {
        String normalizedUsername = normalizeRegistrationUsername(username);
        String normalizedDisplayName = displayName == null ? "" : displayName.trim();
        String validationError = registrationValidationError(
                normalizedUsername,
                password,
                passwordConfirmation,
                normalizedDisplayName
        );
        if (validationError != null) {
            return LoginUiState.error(normalizedUsername, validationError);
        }

        try {
            String installationId = installationIdProvider.installationId();
            JSONObject response = api.mobileRegister(
                    normalizedUsername,
                    password,
                    normalizedDisplayName,
                    installationId
            );
            return saveSession(response, normalizedUsername, installationId);
        } catch (ApiException error) {
            if (error.statusCode() == 409) {
                return LoginUiState.error(normalizedUsername, "Username is already taken");
            }
            if (error.statusCode() == 429) {
                return LoginUiState.error(normalizedUsername, "Too many attempts. Try again later.");
            }
            if (error.statusCode() == 503 || error.statusCode() == 404) {
                return LoginUiState.error(normalizedUsername, "Account registration is unavailable");
            }
            if (error.statusCode() == 400) {
                return LoginUiState.error(normalizedUsername, "Check the account details");
            }
            return LoginUiState.error(normalizedUsername, "Registration failed with HTTP " + error.statusCode());
        } catch (IOException error) {
            return LoginUiState.backendOffline(normalizedUsername);
        } catch (JSONException | GeneralSecurityException | IllegalArgumentException | IllegalStateException error) {
            sessionStore.clear();
            return LoginUiState.error(normalizedUsername, "Could not save the new session");
        }
    }

    public LoginUiState restoreSession() {
        try {
            JSONObject profile = authenticatedSession.execute(api::profile);
            return LoginUiState.signedIn(readUsername(profile, ""));
        } catch (SessionExpiredException error) {
            return LoginUiState.sessionExpired("");
        } catch (ApiException error) {
            return LoginUiState.error("", "Session restore failed with HTTP " + error.statusCode());
        } catch (IOException error) {
            return LoginUiState.backendOffline("");
        } catch (JSONException | GeneralSecurityException error) {
            sessionStore.clear();
            return LoginUiState.error("", "Could not restore saved session");
        }
    }

    public LoginUiState logout() {
        authenticatedSession.logout();
        return LoginUiState.signedOut();
    }

    private static String normalizeUsername(String username) {
        return username == null ? "" : username.trim();
    }

    private LoginUiState saveSession(JSONObject response, String fallbackUsername, String installationId)
            throws GeneralSecurityException {
        JSONObject user = response.optJSONObject("user");
        String ownerId = user == null ? "" : user.optString("id", "");
        if (legacyWindowRecovery != null) {
            legacyWindowRecovery.recover(ownerId, installationId, System.currentTimeMillis());
        }
        sessionStore.saveCredentials(new SessionCredentials(
                response.optString("accessToken", ""),
                response.optString("refreshToken", ""),
                response.optString("refreshTokenExpiresAt", ""),
                ownerId,
                installationId
        ));
        return LoginUiState.signedIn(readUsername(response, fallbackUsername));
    }

    private static String normalizeRegistrationUsername(String username) {
        return normalizeUsername(username).toLowerCase(Locale.ROOT);
    }

    private static String registrationValidationError(
            String username,
            String password,
            String passwordConfirmation,
            String displayName
    ) {
        if (!username.matches("[a-z0-9_]{3,32}")) {
            return "Username must use 3-32 letters, digits, or underscores";
        }
        if (displayName.isEmpty() || displayName.length() > 64 || containsControlCharacter(displayName)) {
            return "Name must contain 1-64 valid characters";
        }
        if (password == null || password.length() < 8 || password.length() > 128 || containsControlCharacter(password)) {
            return "Password must contain 8-128 valid characters";
        }
        if (!password.equals(passwordConfirmation)) {
            return "Passwords do not match";
        }
        return null;
    }

    private static boolean containsControlCharacter(String value) {
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character <= 31 || character == 127) return true;
        }
        return false;
    }

    private static String readUsername(JSONObject response, String fallback) {
        JSONObject user = response.optJSONObject("user");
        if (user == null) {
            return fallback;
        }

        String username = user.optString("username", fallback);
        return username == null || username.trim().isEmpty() ? fallback : username.trim();
    }
}
