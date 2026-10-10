package xyz.etherings.player.home;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;
import xyz.etherings.player.auth.SessionExpiredException;
import xyz.etherings.player.BuildConfig;

public final class HomeRepository {
    private static final String[] SAFE_PROFILE_FIELDS = {
            "ertBalanceExact", "ertBalanceDisplay", "ertBalance",
            "eruBalanceExact", "eruBalanceDisplay", "eruBalance",
            "lifetimeEarnedEruExact", "lifetimeEarnedEruDisplay", "lifetimeEarnedEru",
            "lifetimeSpentEruExact", "lifetimeSpentEruDisplay", "lifetimeSpentEru",
            "lifetimeEarnedErtExact", "lifetimeEarnedErtDisplay", "lifetimeEarnedErt",
            "lifetimeSpentErtExact", "lifetimeSpentErtDisplay", "lifetimeSpentErt",
            "earnedErtExact", "earnedErtDisplay", "earnedErt", "stepCap"
    };

    public enum ErrorKind {
        UNAUTHENTICATED,
        SESSION_EXPIRED,
        BACKEND_OFFLINE,
        ERROR
    }

    public static final class Result {
        private final HomeProfile profile;
        private final ErrorKind errorKind;
        private final String errorMessage;
        private final boolean stale;
        private final boolean serverValuesKnown;

        private Result(HomeProfile profile, ErrorKind errorKind, String errorMessage, boolean stale, boolean serverValuesKnown) {
            this.profile = profile;
            this.errorKind = errorKind;
            this.errorMessage = errorMessage;
            this.stale = stale;
            this.serverValuesKnown = serverValuesKnown;
        }

        public static Result success(HomeProfile profile) {
            return new Result(profile, null, null, false, true);
        }

        public static Result stale(HomeProfile profile, boolean serverValuesKnown, String message) {
            return new Result(profile, null, message, true, serverValuesKnown);
        }

        public static Result error(ErrorKind errorKind, String errorMessage) {
            return new Result(null, errorKind, errorMessage, false, false);
        }

        public boolean isSuccess() {
            return profile != null;
        }

        public HomeProfile profile() {
            return profile;
        }

        public ErrorKind errorKind() {
            return errorKind;
        }

        public String errorMessage() {
            return errorMessage;
        }

        public boolean isStale() {
            return stale;
        }

        public boolean serverValuesKnown() {
            return serverValuesKnown;
        }
    }

    private final HomeProfileApi api;
    private final AuthenticatedSession authenticatedSession;
    private final SessionCredentialStore credentialStore;
    private final HomeProfileStore profileStore;

    public HomeRepository(
            HomeProfileApi api,
            AuthenticatedSession authenticatedSession,
            SessionCredentialStore credentialStore,
            HomeProfileStore profileStore
    ) {
        this.api = api;
        this.authenticatedSession = authenticatedSession;
        this.credentialStore = credentialStore;
        this.profileStore = profileStore;
    }

    public Result loadHomeProfile() {
        String ownerId;
        try {
            SessionCredentials credentials = credentialStore.getCredentials();
            if (credentials == null) {
                return Result.error(ErrorKind.UNAUTHENTICATED, "Sign in is required");
            }
            ownerId = credentials.ownerId();
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            return Result.error(ErrorKind.ERROR, "Could not read saved session");
        }

        try {
            JSONObject profile = authenticatedSession.execute(api::profile);
            HomeProfile parsed = HomeProfile.fromJson(profile);
            if (parsed.userId().isEmpty() || !ownerId.equals(parsed.userId())) {
                return Result.error(ErrorKind.ERROR, "Profile response is missing the owner identity");
            }
            profileStore.save(parsed);
            return Result.success(parsed);
        } catch (SessionExpiredException error) {
            return Result.error(ErrorKind.SESSION_EXPIRED, "Session expired. Sign in again.");
        } catch (ApiException error) {
            if (error.statusCode() >= 500) {
                return offline(ownerId, "Server data is temporarily unavailable");
            }
            return Result.error(ErrorKind.ERROR, "Profile request failed with HTTP " + error.statusCode());
        } catch (JSONException error) {
            String message = "Could not parse profile response";
            if (BuildConfig.DEBUG) {
                message += " [field: " + safeRejectedField(error) + "]";
            }
            return Result.error(ErrorKind.ERROR, message);
        } catch (IOException error) {
            return offline(ownerId, "Server data is unavailable; local tracking remains active");
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            return Result.error(ErrorKind.ERROR, "Could not read saved session");
        }
    }

    private static String safeRejectedField(JSONException error) {
        String message = error.getMessage();
        if (message != null) {
            for (String field : SAFE_PROFILE_FIELDS) {
                if (message.contains(field)) return field;
            }
        }
        return "unknown";
    }

    private Result offline(String ownerId, String message) {
        HomeProfile cached = profileStore.snapshot(ownerId);
        return Result.stale(
                cached == null ? HomeProfile.offlineOwner(ownerId) : cached,
                cached != null,
                message
        );
    }
}
