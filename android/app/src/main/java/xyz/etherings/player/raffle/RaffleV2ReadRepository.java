package xyz.etherings.player.raffle;

import org.json.JSONException;

import java.io.IOException;
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.SessionExpiredException;

public final class RaffleV2ReadRepository {
    public enum ErrorKind { SESSION_EXPIRED, BACKEND_OFFLINE, UNAVAILABLE, ERROR }

    public static final class Result<T> {
        private final T value;
        private final ErrorKind errorKind;
        private final String errorMessage;

        private Result(T value, ErrorKind errorKind, String errorMessage) {
            this.value = value;
            this.errorKind = errorKind;
            this.errorMessage = errorMessage;
        }

        public static <T> Result<T> success(T value) { return new Result<>(value, null, null); }
        public static <T> Result<T> error(ErrorKind kind, String message) { return new Result<>(null, kind, message); }
        public boolean isSuccess() { return value != null; }
        public T value() { return value; }
        public ErrorKind errorKind() { return errorKind; }
        public String errorMessage() { return errorMessage; }
    }

    private final RaffleV2Api api;
    private final AuthenticatedSession session;

    public RaffleV2ReadRepository(RaffleV2Api api, AuthenticatedSession session) {
        this.api = api;
        this.session = session;
    }

    public Result<RaffleV2Draw> loadCurrent() {
        try {
            return Result.success(RaffleV2Draw.fromJson(session.execute(api::currentDraw)));
        } catch (SessionExpiredException | GeneralSecurityException error) {
            return Result.error(ErrorKind.SESSION_EXPIRED, "Session expired. Sign in again.");
        } catch (ApiException error) {
            return error.statusCode() == 404
                    ? Result.error(ErrorKind.UNAVAILABLE, "Draw is unavailable.")
                    : Result.error(ErrorKind.ERROR, "Draw request failed with HTTP " + error.statusCode() + ".");
        } catch (IOException error) {
            return Result.error(ErrorKind.BACKEND_OFFLINE, "Backend is unavailable.");
        } catch (JSONException error) {
            return Result.error(ErrorKind.ERROR, "Draw response is invalid.");
        }
    }

    public Result<RaffleV2HistoryPage> loadHistory(int limit, String cursor) {
        if (limit < 1 || limit > 50) return Result.error(ErrorKind.ERROR, "History limit is invalid.");
        try {
            return Result.success(RaffleV2HistoryPage.fromJson(
                    session.execute(token -> api.drawHistory(limit, cursor, token))));
        } catch (SessionExpiredException | GeneralSecurityException error) {
            return Result.error(ErrorKind.SESSION_EXPIRED, "Session expired. Sign in again.");
        } catch (ApiException error) {
            return Result.error(ErrorKind.ERROR, "Draw history request failed with HTTP " + error.statusCode() + ".");
        } catch (IOException error) {
            return Result.error(ErrorKind.BACKEND_OFFLINE, "Backend is unavailable.");
        } catch (JSONException error) {
            return Result.error(ErrorKind.ERROR, "Draw history response is invalid.");
        }
    }
}
