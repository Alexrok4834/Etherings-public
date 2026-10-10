package xyz.etherings.player.alpha;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.profile.ActivityHistoryRepository;
import xyz.etherings.player.profile.DailyActivityItem;

/** Account-scoped Alpha history using the same daily row contract as MVP. */
public final class AlphaActivityHistoryClient {
    private AlphaActivityHistoryClient() { }

    public static ActivityHistoryRepository.Result load(Context context, LocalDate today) {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        AlphaSessionStore.VerifiedSession session = sessions.verified();
        if (session == null) return ActivityHistoryRepository.Result.error(
                ActivityHistoryRepository.ErrorKind.SESSION_EXPIRED, "Sign in to view activity.");
        String from = today.minusDays(29).toString();
        String to = today.toString();
        try {
            AlphaAuthApi api = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL);
            AlphaAuthApi.Result response = api.get(
                    "/m2e/activity?from=" + from + "&to=" + to, session.token());
            if (response.status == 401) return ActivityHistoryRepository.Result.error(
                    ActivityHistoryRepository.ErrorKind.SESSION_EXPIRED, "Alpha session expired.");
            if (response.status != 200) return ActivityHistoryRepository.Result.error(
                    ActivityHistoryRepository.ErrorKind.ERROR, "Activity is unavailable.");
            JSONObject body = response.body;
            if (!from.equals(body.getString("from")) || !to.equals(body.getString("to")))
                throw new IllegalStateException("Activity range mismatch");
            Integer currentCap = null;
            try {
                AlphaAuthApi.Result current = api.get("/m2e/today?date=" + to, session.token());
                if (current.status == 401) return ActivityHistoryRepository.Result.error(
                        ActivityHistoryRepository.ErrorKind.SESSION_EXPIRED, "Alpha session expired.");
                if (current.status == 200 && to.equals(current.body.getString("date"))) {
                    Object raw = current.body.opt("dailyStepCap");
                    if (raw instanceof Integer && (Integer) raw > 0) currentCap = (Integer) raw;
                }
            } catch (Exception ignored) {
                // Current capacity is UNKNOWN; historical rows remain available.
            }
            JSONArray days = body.getJSONArray("days");
            List<DailyActivityItem> items = new ArrayList<>();
            for (int index = 0; index < days.length(); index++) {
                DailyActivityItem item = DailyActivityItem.fromJson(days.getJSONObject(index));
                if (item.date().isBefore(today.minusDays(29)) || item.date().isAfter(today))
                    throw new IllegalStateException("Activity date outside requested range");
                if (item.date().equals(today)) item = item.withCurrentStepCap(currentCap);
                items.add(item);
            }
            AlphaSessionStore.VerifiedSession current = sessions.verified();
            if (current == null || !session.lineage().equals(current.lineage()) ||
                    !session.ownerId().equals(current.ownerId()))
                return ActivityHistoryRepository.Result.error(
                        ActivityHistoryRepository.ErrorKind.SESSION_EXPIRED, "Alpha session changed.");
            return ActivityHistoryRepository.Result.success(items);
        } catch (IOException error) {
            return ActivityHistoryRepository.Result.error(
                    ActivityHistoryRepository.ErrorKind.BACKEND_OFFLINE,
                    "Activity is unavailable. Retry when online.");
        } catch (Exception error) {
            return ActivityHistoryRepository.Result.error(
                    ActivityHistoryRepository.ErrorKind.ERROR,
                    "Could not read account activity.");
        }
    }
}
