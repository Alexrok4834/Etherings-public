package xyz.etherings.player.profile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.SessionExpiredException;

public final class ActivityHistoryRepository {
    public enum ErrorKind {
        SESSION_EXPIRED,
        BACKEND_OFFLINE,
        ERROR
    }

    public static final class Result {
        private final List<DailyActivityItem> items;
        private final ErrorKind errorKind;
        private final String errorMessage;

        private Result(List<DailyActivityItem> items, ErrorKind errorKind, String errorMessage) {
            this.items = items;
            this.errorKind = errorKind;
            this.errorMessage = errorMessage;
        }

        public static Result success(List<DailyActivityItem> items) {
            return new Result(Collections.unmodifiableList(new ArrayList<>(items)), null, null);
        }

        public static Result error(ErrorKind errorKind, String errorMessage) {
            return new Result(null, errorKind, errorMessage);
        }

        public boolean isSuccess() {
            return items != null;
        }

        public List<DailyActivityItem> items() {
            return items;
        }

        public ErrorKind errorKind() {
            return errorKind;
        }

        public String errorMessage() {
            return errorMessage;
        }
    }

    private final ActivityHistoryApi api;
    private final AuthenticatedSession authenticatedSession;

    public ActivityHistoryRepository(ActivityHistoryApi api, AuthenticatedSession authenticatedSession) {
        this.api = api;
        this.authenticatedSession = authenticatedSession;
    }

    public Result loadLast30Days(LocalDate today) {
        String from = today.minusDays(29).toString();
        String to = today.toString();
        try {
            JSONObject response = authenticatedSession.execute(token -> api.activityHistory(from, to, token));
            JSONArray days = response.getJSONArray("days");
            List<DailyActivityItem> items = new ArrayList<>();
            for (int index = 0; index < days.length(); index += 1) {
                items.add(DailyActivityItem.fromJson(days.getJSONObject(index)));
            }
            return Result.success(items);
        } catch (SessionExpiredException | GeneralSecurityException error) {
            return Result.error(ErrorKind.SESSION_EXPIRED, "Session expired. Sign in again.");
        } catch (IOException error) {
            return Result.error(ErrorKind.BACKEND_OFFLINE, "Activity is unavailable while offline.");
        } catch (ApiException error) {
            return Result.error(ErrorKind.ERROR, "Activity request failed with HTTP " + error.statusCode() + ".");
        } catch (JSONException error) {
            return Result.error(ErrorKind.ERROR, "Could not read activity history.");
        }
    }
}
