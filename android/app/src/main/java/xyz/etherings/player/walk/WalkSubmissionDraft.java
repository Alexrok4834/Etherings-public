package xyz.etherings.player.walk;

import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

import xyz.etherings.player.step.StepCounterSnapshot;

public final class WalkSubmissionDraft {
    public static final String ALGORITHM_VERSION = "android-step-counter-v1";
    public static final String STATE_START_PENDING = "START_PENDING";
    public static final String STATE_FINISH_PENDING = "FINISH_PENDING";
    public static final String STATE_ACCEPTED = "ACCEPTED";
    public static final String STATE_REJECTED = "REJECTED";
    public static final String STATE_FAILED_RETRYABLE = "FAILED_RETRYABLE";

    private static final int MAX_ANDROID_INT = Integer.MAX_VALUE;
    private static final ThreadLocal<SimpleDateFormat> ISO_FORMAT = ThreadLocal.withInitial(() -> {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format;
    });

    private final String localSubmissionId;
    private final String backendSessionId;
    private final long windowStartedAtMs;
    private final long windowEndedAtMs;
    private final long rawCounterAtSubmit;
    private final long rewardWindowStepsAtSubmit;
    private final long dailyStepsAtSubmit;
    private final int eventCountAtSubmit;
    private final String algorithmVersion;
    private final String state;
    private final String lastErrorSummary;

    public WalkSubmissionDraft(
            String localSubmissionId,
            String backendSessionId,
            long windowStartedAtMs,
            long windowEndedAtMs,
            long rawCounterAtSubmit,
            long rewardWindowStepsAtSubmit,
            long dailyStepsAtSubmit,
            int eventCountAtSubmit,
            String algorithmVersion,
            String state,
            String lastErrorSummary
    ) {
        this.localSubmissionId = emptyToGenerated(localSubmissionId);
        this.backendSessionId = cleanNullable(backendSessionId);
        this.windowStartedAtMs = Math.max(0L, windowStartedAtMs);
        this.windowEndedAtMs = Math.max(this.windowStartedAtMs + 1000L, windowEndedAtMs);
        this.rawCounterAtSubmit = Math.max(0L, rawCounterAtSubmit);
        this.rewardWindowStepsAtSubmit = Math.max(0L, rewardWindowStepsAtSubmit);
        this.dailyStepsAtSubmit = Math.max(0L, dailyStepsAtSubmit);
        this.eventCountAtSubmit = Math.max(0, eventCountAtSubmit);
        this.algorithmVersion = isBlank(algorithmVersion) ? ALGORITHM_VERSION : algorithmVersion;
        this.state = isBlank(state) ? STATE_START_PENDING : state;
        this.lastErrorSummary = cleanNullable(lastErrorSummary);
    }

    public static WalkSubmissionDraft capture(StepCounterSnapshot snapshot, long nowMs) {
        long safeNow = Math.max(0L, nowMs);
        long startedAt = snapshot == null ? safeNow : snapshot.rewardWindowStartedAtMs();
        if (startedAt <= 0L || startedAt > safeNow) {
            startedAt = safeNow;
        }

        return new WalkSubmissionDraft(
                UUID.randomUUID().toString(),
                null,
                startedAt,
                safeNow,
                snapshot == null ? 0L : snapshot.lastRawCounter(),
                snapshot == null ? 0L : snapshot.rewardWindowSteps(),
                snapshot == null ? 0L : snapshot.dailySteps(),
                snapshot == null ? 0 : snapshot.eventCount(),
                ALGORITHM_VERSION,
                STATE_START_PENDING,
                null
        );
    }

    public WalkSubmissionDraft withBackendSessionId(String backendSessionId) {
        return new WalkSubmissionDraft(
                localSubmissionId,
                backendSessionId,
                windowStartedAtMs,
                windowEndedAtMs,
                rawCounterAtSubmit,
                rewardWindowStepsAtSubmit,
                dailyStepsAtSubmit,
                eventCountAtSubmit,
                algorithmVersion,
                STATE_FINISH_PENDING,
                null
        );
    }

    public WalkSubmissionDraft withState(String nextState, String errorSummary) {
        return new WalkSubmissionDraft(
                localSubmissionId,
                backendSessionId,
                windowStartedAtMs,
                windowEndedAtMs,
                rawCounterAtSubmit,
                rewardWindowStepsAtSubmit,
                dailyStepsAtSubmit,
                eventCountAtSubmit,
                algorithmVersion,
                nextState,
                errorSummary
        );
    }

    public JSONObject toFinishPayload() throws JSONException {
        JSONObject body = new JSONObject();
        body.put("clientStepCount", clientStepCount());
        body.put("startedAt", iso(windowStartedAtMs));
        body.put("endedAt", iso(windowEndedAtMs));
        body.put("durationSeconds", durationSeconds());
        body.put("distanceMeters", JSONObject.NULL);
        body.put("samplesCount", eventCountAtSubmit);
        body.put("algorithmVersion", algorithmVersion);
        return body;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("localSubmissionId", localSubmissionId);
        json.put("backendSessionId", backendSessionId == null ? JSONObject.NULL : backendSessionId);
        json.put("windowStartedAtMs", windowStartedAtMs);
        json.put("windowEndedAtMs", windowEndedAtMs);
        json.put("rawCounterAtSubmit", rawCounterAtSubmit);
        json.put("rewardWindowStepsAtSubmit", rewardWindowStepsAtSubmit);
        json.put("dailyStepsAtSubmit", dailyStepsAtSubmit);
        json.put("eventCountAtSubmit", eventCountAtSubmit);
        json.put("algorithmVersion", algorithmVersion);
        json.put("state", state);
        json.put("lastErrorSummary", lastErrorSummary == null ? JSONObject.NULL : lastErrorSummary);
        return json;
    }

    public static WalkSubmissionDraft fromJson(JSONObject json) {
        return new WalkSubmissionDraft(
                json.optString("localSubmissionId", null),
                optNullableString(json, "backendSessionId"),
                json.optLong("windowStartedAtMs", 0L),
                json.optLong("windowEndedAtMs", 0L),
                json.optLong("rawCounterAtSubmit", 0L),
                json.optLong("rewardWindowStepsAtSubmit", 0L),
                json.optLong("dailyStepsAtSubmit", 0L),
                json.optInt("eventCountAtSubmit", 0),
                json.optString("algorithmVersion", ALGORITHM_VERSION),
                json.optString("state", STATE_START_PENDING),
                optNullableString(json, "lastErrorSummary")
        );
    }

    public String localSubmissionId() {
        return localSubmissionId;
    }

    public String backendSessionId() {
        return backendSessionId;
    }

    public long rewardWindowStepsAtSubmit() {
        return rewardWindowStepsAtSubmit;
    }

    public long windowStartedAtMs() {
        return windowStartedAtMs;
    }

    public long windowEndedAtMs() {
        return windowEndedAtMs;
    }

    public String state() {
        return state;
    }

    public int clientStepCount() {
        return (int) Math.min(rewardWindowStepsAtSubmit, MAX_ANDROID_INT);
    }

    public int durationSeconds() {
        return Math.max(1, (int) ((windowEndedAtMs - windowStartedAtMs) / 1000L));
    }

    private static String iso(long timestampMs) {
        return ISO_FORMAT.get().format(new Date(Math.max(0L, timestampMs)));
    }

    private static String optNullableString(JSONObject json, String key) {
        if (json.isNull(key)) {
            return null;
        }
        return cleanNullable(json.optString(key, null));
    }

    private static String emptyToGenerated(String value) {
        return isBlank(value) ? UUID.randomUUID().toString() : value;
    }

    private static String cleanNullable(String value) {
        return isBlank(value) ? null : value;
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }
}
