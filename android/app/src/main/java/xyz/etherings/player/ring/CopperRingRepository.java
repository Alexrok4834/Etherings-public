package xyz.etherings.player.ring;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;
import xyz.etherings.player.auth.SessionExpiredException;

public final class CopperRingRepository {
    public enum ErrorKind {
        UNAUTHENTICATED,
        SESSION_EXPIRED,
        NOT_FOUND,
        CONFLICT,
        BACKEND_UNAVAILABLE,
        INSUFFICIENT_ERT,
        CURRENCY_UNAVAILABLE,
        STALE_LEVEL,
        STALE_POINTS,
        INSUFFICIENT_POINTS,
        IDEMPOTENCY_CONFLICT,
        ERROR
    }

    public static final class Result<T> {
        private final T value;
        private final ErrorKind errorKind;
        private final String errorMessage;
        private final boolean stale;
        private final long cachedAtMs;

        private Result(T value, ErrorKind errorKind, String errorMessage, boolean stale, long cachedAtMs) {
            this.value = value;
            this.errorKind = errorKind;
            this.errorMessage = errorMessage;
            this.stale = stale;
            this.cachedAtMs = cachedAtMs;
        }

        static <T> Result<T> success(T value) {
            return new Result<>(value, null, null, false, 0L);
        }

        static <T> Result<T> stale(T value, String message, long cachedAtMs) {
            return new Result<>(value, null, message, true, cachedAtMs);
        }

        static <T> Result<T> error(ErrorKind kind, String message) {
            return new Result<>(null, kind, message, false, 0L);
        }

        public boolean isSuccess() { return value != null; }
        public T value() { return value; }
        public ErrorKind errorKind() { return errorKind; }
        public String errorMessage() { return errorMessage; }
        public boolean isStale() { return stale; }
        public long cachedAtMs() { return cachedAtMs; }
    }

    private interface NetworkRead<T> {
        T execute(String accessToken) throws IOException, JSONException, ApiException;
    }

    private interface CacheRead<T> {
        CopperRingCache.Snapshot<T> read(String ownerId);
    }

    private final CopperRingApi api;
    private final AuthenticatedSession authenticatedSession;
    private final SessionCredentialStore credentialStore;
    private final CopperRingCache cache;

    public CopperRingRepository(
            CopperRingApi api,
            AuthenticatedSession authenticatedSession,
            SessionCredentialStore credentialStore,
            CopperRingCache cache
    ) {
        this.api = api;
        this.authenticatedSession = authenticatedSession;
        this.credentialStore = credentialStore;
        this.cache = cache;
    }

    public Result<List<CopperRing>> loadInventory() {
        String ownerId;
        try {
            ownerId = ownerId();
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            return Result.error(ErrorKind.ERROR, "Could not read saved session");
        }
        if (ownerId == null) return Result.error(ErrorKind.UNAUTHENTICATED, "Sign in is required");
        return load(
                ownerId,
                accessToken -> parseInventory(api.rings(accessToken)),
                cache::inventory,
                rings -> cache.saveInventory(ownerId, rings)
        );
    }

    public Result<CopperRing> loadDetail(String ringId) {
        if (!validUuid(ringId)) return Result.error(ErrorKind.ERROR, "Ring ID is invalid");
        String ownerId;
        try {
            ownerId = ownerId();
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            return Result.error(ErrorKind.ERROR, "Could not read saved session");
        }
        if (ownerId == null) return Result.error(ErrorKind.UNAUTHENTICATED, "Sign in is required");
        return load(
                ownerId,
                accessToken -> CopperRing.fromJson(api.ring(ringId, accessToken)),
                ignored -> cache.detail(ownerId, ringId),
                ring -> cache.saveDetail(ownerId, ring)
        );
    }

    public Result<EquippedCopperRing> loadEquipped() {
        String ownerId;
        try {
            ownerId = ownerId();
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            return Result.error(ErrorKind.ERROR, "Could not read saved session");
        }
        if (ownerId == null) return Result.error(ErrorKind.UNAUTHENTICATED, "Sign in is required");
        return load(
                ownerId,
                accessToken -> EquippedCopperRing.fromJson(api.equippedRing(accessToken)),
                cache::equipped,
                equipped -> cache.saveEquipped(ownerId, equipped)
        );
    }

    public Result<CopperLevelPreview> previewLevelUp(CopperRing ring) {
        try {
            JSONObject body = levelBody(ring);
            return Result.success(authenticatedSession.execute(accessToken ->
                    CopperLevelPreview.fromJson(api.previewLevelUp(ring.id(), body, accessToken))));
        } catch (Exception error) {
            return mutationError(error);
        }
    }

    public Result<CopperLevelUpResult> levelUp(
            CopperRing ring,
            String idempotencyKey
    ) {
        try {
            JSONObject body = levelBody(ring).put("idempotencyKey", idempotencyKey);
            return Result.success(authenticatedSession.execute(accessToken ->
                    CopperLevelUpResult.fromJson(api.levelUp(ring.id(), body, accessToken))));
        } catch (Exception error) {
            return mutationError(error);
        }
    }

    public Result<CopperAttributeAllocationResult> allocateAttributePoints(
            CopperRing ring,
            CopperAttributeAllocation allocation,
            String idempotencyKey
    ) {
        try {
            JSONObject body = new JSONObject()
                    .put("expectedUnspentPoints", ring.unspentAttributePoints())
                    .put("allocation", allocation.toJson())
                    .put("idempotencyKey", idempotencyKey);
            return Result.success(authenticatedSession.execute(accessToken ->
                    CopperAttributeAllocationResult.fromJson(
                            api.allocateAttributePoints(ring.id(), body, accessToken))));
        } catch (Exception error) {
            return mutationError(error);
        }
    }

    public Result<EquippedCopperRing> equip(
            CopperRing ring,
            String expectedEquippedRingId,
            String idempotencyKey
    ) {
        try {
            String ownerId = ownerId();
            if (ownerId == null) {
                return Result.error(ErrorKind.UNAUTHENTICATED, "Sign in is required");
            }
            JSONObject body = new JSONObject()
                    .put("contractVersion", "ring-equipment-v1")
                    .put("expectedEquippedRingId", expectedEquippedRingId)
                    .put("idempotencyKey", idempotencyKey);
            EquippedCopperRing equipped = authenticatedSession.execute(accessToken ->
                    EquippedCopperRing.fromJson(api.equipRing(ring.id(), body, accessToken)));
            cache.saveDetail(ownerId, equipped.ring());
            cache.saveEquipped(ownerId, equipped);
            return Result.success(equipped);
        } catch (Exception error) {
            return mutationError(error);
        }
    }

    private JSONObject levelBody(CopperRing ring) throws JSONException {
        return new JSONObject().put("expectedCurrentLevel", ring.level())
                .put("targetLevel", ring.level() + 1);
    }

    private <T> Result<T> mutationError(Exception error) {
        if (error instanceof SessionExpiredException) {
            return Result.error(ErrorKind.SESSION_EXPIRED, "Session expired. Sign in again.");
        }
        if (error instanceof ApiException) {
            ApiException apiError = (ApiException) error;
            String code = errorCode(apiError);
            if ("RING_LEVEL_INSUFFICIENT_ERT".equals(code)) return Result.error(ErrorKind.INSUFFICIENT_ERT, "Not enough ERT");
            if ("RING_LEVEL_CURRENCY_UNAVAILABLE".equals(code)) return Result.error(ErrorKind.CURRENCY_UNAVAILABLE, "Required currency is unavailable");
            if ("RING_LEVEL_STALE".equals(code)) return Result.error(ErrorKind.STALE_LEVEL, "Ring level changed. Reload and try again.");
            if ("RING_ATTRIBUTE_POINTS_STALE".equals(code)) return Result.error(ErrorKind.STALE_POINTS, "Accumulated points changed. Ring data will be reloaded.");
            if ("RING_ATTRIBUTE_POINTS_INSUFFICIENT".equals(code)) return Result.error(ErrorKind.INSUFFICIENT_POINTS, "Not enough accumulated points");
            if ("RING_EQUIPMENT_STALE".equals(code)) return Result.error(ErrorKind.CONFLICT, "Equipped Ring changed. Reload and try again.");
            if ("RING_LEVEL_IDEMPOTENCY_CONFLICT".equals(code)
                    || "RING_ATTRIBUTE_ALLOCATION_IDEMPOTENCY_CONFLICT".equals(code)
                    || "RING_EQUIPMENT_IDEMPOTENCY_CONFLICT".equals(code)) {
                return Result.error(ErrorKind.IDEMPOTENCY_CONFLICT, "Retry conflicts with the original request");
            }
            if (apiError.statusCode() == 503) return Result.error(ErrorKind.BACKEND_UNAVAILABLE, "Ring update is temporarily unavailable");
            return Result.error(ErrorKind.ERROR, "Ring update failed with HTTP " + apiError.statusCode());
        }
        if (error instanceof IOException) return Result.error(ErrorKind.BACKEND_UNAVAILABLE, "Connection lost. Retry the same update.");
        if (error instanceof GeneralSecurityException) return Result.error(ErrorKind.ERROR, "Could not read saved session");
        return Result.error(ErrorKind.ERROR, "Could not process ring update response");
    }

    private <T> Result<T> load(
            String ownerId,
            NetworkRead<T> network,
            CacheRead<T> cached,
            java.util.function.Consumer<T> save
    ) {
        try {
            T value = authenticatedSession.execute(network::execute);
            save.accept(value);
            return Result.success(value);
        } catch (SessionExpiredException error) {
            return Result.error(ErrorKind.SESSION_EXPIRED, "Session expired. Sign in again.");
        } catch (ApiException error) {
            String code = errorCode(error);
            if (error.statusCode() == 404 && "RING_NOT_FOUND".equals(code)) {
                return Result.error(ErrorKind.NOT_FOUND, "Cooper ring was not found");
            }
            if (error.statusCode() == 409 && "RING_STATE_CONFLICT".equals(code)) {
                return Result.error(ErrorKind.CONFLICT, "Cooper ring state requires support");
            }
            if (error.statusCode() == 503 && "RING_READ_UNAVAILABLE".equals(code)) {
                return staleOrUnavailable(ownerId, cached, "Cooper ring data is temporarily unavailable");
            }
            return Result.error(ErrorKind.ERROR, "Cooper ring request failed with HTTP " + error.statusCode());
        } catch (IOException error) {
            return staleOrUnavailable(ownerId, cached, "Offline Cooper ring data");
        } catch (GeneralSecurityException error) {
            return Result.error(ErrorKind.ERROR, "Could not read saved session");
        } catch (JSONException | IllegalArgumentException error) {
            return Result.error(ErrorKind.ERROR, "Could not parse Cooper ring data");
        }
    }

    private <T> Result<T> staleOrUnavailable(String ownerId, CacheRead<T> cached, String message) {
        CopperRingCache.Snapshot<T> snapshot = cached.read(ownerId);
        if (snapshot == null) return Result.error(ErrorKind.BACKEND_UNAVAILABLE, message);
        return Result.stale(snapshot.value(), message, snapshot.cachedAtMs());
    }

    private String ownerId() throws GeneralSecurityException {
        SessionCredentials credentials = credentialStore.getCredentials();
        return credentials == null ? null : credentials.ownerId();
    }

    private List<CopperRing> parseInventory(JSONObject response) throws JSONException {
        JSONArray encoded = response.getJSONArray("rings");
        List<CopperRing> rings = new ArrayList<>();
        for (int index = 0; index < encoded.length(); index++) {
            rings.add(CopperRing.fromJson(encoded.getJSONObject(index)));
        }
        return Collections.unmodifiableList(rings);
    }

    private String errorCode(ApiException error) {
        try {
            return new JSONObject(error.responseBody()).optString("code", "");
        } catch (JSONException ignored) {
            return "";
        }
    }

    private boolean validUuid(String value) {
        try {
            UUID.fromString(value);
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }
}
