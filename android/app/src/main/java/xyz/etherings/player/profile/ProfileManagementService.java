package xyz.etherings.player.profile;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.SessionExpiredException;
import xyz.etherings.player.home.HomeProfile;
import xyz.etherings.player.home.HomeProfileStore;

public final class ProfileManagementService {
    public enum ErrorKind {
        VALIDATION,
        CURRENT_PASSWORD,
        SESSION_EXPIRED,
        BACKEND_OFFLINE,
        ERROR
    }

    public static final class Result {
        private final HomeProfile profile;
        private final boolean passwordChanged;
        private final ErrorKind errorKind;
        private final String message;

        private Result(HomeProfile profile, boolean passwordChanged, ErrorKind errorKind, String message) {
            this.profile = profile;
            this.passwordChanged = passwordChanged;
            this.errorKind = errorKind;
            this.message = message;
        }

        public static Result profileUpdated(HomeProfile profile) {
            return new Result(profile, false, null, "Name updated");
        }

        public static Result passwordChanged() {
            return new Result(null, true, null, "Password changed. Sign in again.");
        }

        public static Result error(ErrorKind kind, String message) {
            return new Result(null, false, kind, message);
        }

        public boolean isSuccess() {
            return profile != null || passwordChanged;
        }

        public HomeProfile profile() {
            return profile;
        }

        public boolean isPasswordChanged() {
            return passwordChanged;
        }

        public ErrorKind errorKind() {
            return errorKind;
        }

        public String message() {
            return message;
        }
    }

    private final ProfileManagementApi api;
    private final AuthenticatedSession authenticatedSession;
    private final HomeProfileStore profileStore;

    public ProfileManagementService(
            ProfileManagementApi api,
            AuthenticatedSession authenticatedSession,
            HomeProfileStore profileStore
    ) {
        this.api = api;
        this.authenticatedSession = authenticatedSession;
        this.profileStore = profileStore;
    }

    public Result updateDisplayName(String rawDisplayName) {
        String displayName = rawDisplayName == null ? "" : rawDisplayName.trim();
        if (!validDisplayName(displayName)) {
            return Result.error(ErrorKind.VALIDATION, "Name must contain 1-64 valid characters.");
        }

        try {
            JSONObject response = authenticatedSession.execute(
                    token -> api.updateDisplayName(displayName, token)
            );
            HomeProfile profile = HomeProfile.fromJson(response);
            if (profile.userId().isEmpty()) {
                return Result.error(ErrorKind.ERROR, "Profile response is incomplete.");
            }
            profileStore.save(profile);
            return Result.profileUpdated(profile);
        } catch (SessionExpiredException error) {
            return Result.error(ErrorKind.SESSION_EXPIRED, "Session expired. Sign in again.");
        } catch (ApiException error) {
            return Result.error(ErrorKind.ERROR, apiMessage(error, "Could not update name"));
        } catch (IOException error) {
            return Result.error(ErrorKind.BACKEND_OFFLINE, "Server is unavailable. Try again later.");
        } catch (JSONException error) {
            return Result.error(ErrorKind.ERROR, "Could not read the updated profile.");
        } catch (GeneralSecurityException error) {
            return Result.error(ErrorKind.ERROR, "Could not read the saved session.");
        }
    }

    public Result changePassword(String currentPassword, String newPassword, String confirmation) {
        if (currentPassword == null || currentPassword.isEmpty()) {
            return Result.error(ErrorKind.VALIDATION, "Enter the current password.");
        }
        if (!validNewPassword(newPassword)) {
            return Result.error(ErrorKind.VALIDATION, "New password must contain 8-128 valid characters.");
        }
        if (!newPassword.equals(confirmation)) {
            return Result.error(ErrorKind.VALIDATION, "New passwords do not match.");
        }
        if (currentPassword.equals(newPassword)) {
            return Result.error(ErrorKind.VALIDATION, "New password must be different.");
        }

        try {
            authenticatedSession.execute(token -> api.changePassword(currentPassword, newPassword, token));
            authenticatedSession.invalidateLocally();
            return Result.passwordChanged();
        } catch (SessionExpiredException error) {
            return Result.error(ErrorKind.SESSION_EXPIRED, "Session expired. Sign in again.");
        } catch (ApiException error) {
            if (error.statusCode() == 403) {
                return Result.error(ErrorKind.CURRENT_PASSWORD, "Current password is incorrect.");
            }
            return Result.error(ErrorKind.ERROR, apiMessage(error, "Could not change password"));
        } catch (IOException error) {
            return Result.error(ErrorKind.BACKEND_OFFLINE, "Server is unavailable. Try again later.");
        } catch (JSONException error) {
            return Result.error(ErrorKind.ERROR, "Could not read the password response.");
        } catch (GeneralSecurityException error) {
            return Result.error(ErrorKind.ERROR, "Could not read the saved session.");
        }
    }

    private static boolean validDisplayName(String value) {
        return !value.isEmpty() && value.length() <= 64 && !containsControlCharacter(value);
    }

    private static boolean validNewPassword(String value) {
        return value != null && value.length() >= 8 && value.length() <= 128 && !containsControlCharacter(value);
    }

    private static boolean containsControlCharacter(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (Character.isISOControl(value.charAt(index))) return true;
        }
        return false;
    }

    private static String apiMessage(ApiException error, String fallback) {
        return fallback + " (HTTP " + error.statusCode() + ").";
    }
}
