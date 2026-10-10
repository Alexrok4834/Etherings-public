package xyz.etherings.player.ring;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class CopperRingUiState {
    public enum Screen { WALK, INVENTORY, DETAIL }

    public enum Status {
        LOADING,
        EMPTY,
        CONTENT,
        OFFLINE_STALE,
        UNAVAILABLE,
        SESSION_EXPIRED
    }

    private final Screen screen;
    private final Status status;
    private final List<CopperRing> rings;
    private final CopperRing ring;
    private final String message;
    private final long cachedAtMs;

    private CopperRingUiState(
            Screen screen,
            Status status,
            List<CopperRing> rings,
            CopperRing ring,
            String message,
            long cachedAtMs
    ) {
        this.screen = screen;
        this.status = status;
        this.rings = rings == null
                ? Collections.emptyList()
                : Collections.unmodifiableList(new ArrayList<>(rings));
        this.ring = ring;
        this.message = message == null ? "" : message;
        this.cachedAtMs = cachedAtMs;
    }

    public static CopperRingUiState loadingInventory() {
        return new CopperRingUiState(Screen.INVENTORY, Status.LOADING, null, null, "", 0L);
    }

    public static CopperRingUiState loadingWalk() {
        return new CopperRingUiState(Screen.WALK, Status.LOADING, null, null, "", 0L);
    }

    public static CopperRingUiState loadingDetail() {
        return new CopperRingUiState(Screen.DETAIL, Status.LOADING, null, null, "", 0L);
    }

    public static CopperRingUiState fromInventory(CopperRingRepository.Result<List<CopperRing>> result) {
        if (result.isSuccess()) {
            List<CopperRing> rings = result.value();
            if (result.isStale()) {
                return new CopperRingUiState(
                        Screen.INVENTORY,
                        Status.OFFLINE_STALE,
                        rings,
                        null,
                        result.errorMessage(),
                        result.cachedAtMs()
                );
            }
            return new CopperRingUiState(
                    Screen.INVENTORY,
                    rings.isEmpty() ? Status.EMPTY : Status.CONTENT,
                    rings,
                    null,
                    "",
                    0L
            );
        }
        return error(Screen.INVENTORY, result.errorKind(), result.errorMessage());
    }

    public static CopperRingUiState fromDetail(CopperRingRepository.Result<CopperRing> result) {
        if (result.isSuccess()) {
            return new CopperRingUiState(
                    Screen.DETAIL,
                    result.isStale() ? Status.OFFLINE_STALE : Status.CONTENT,
                    null,
                    result.value(),
                    result.errorMessage(),
                    result.cachedAtMs()
            );
        }
        return error(Screen.DETAIL, result.errorKind(), result.errorMessage());
    }

    public static CopperRingUiState fromEquipped(CopperRingRepository.Result<EquippedCopperRing> result) {
        if (result.isSuccess()) {
            return new CopperRingUiState(
                    Screen.WALK,
                    result.isStale() ? Status.OFFLINE_STALE : Status.CONTENT,
                    Collections.singletonList(result.value().ring()),
                    null,
                    result.errorMessage(),
                    result.cachedAtMs()
            );
        }
        return error(Screen.WALK, result.errorKind(), result.errorMessage());
    }

    private static CopperRingUiState error(
            Screen screen,
            CopperRingRepository.ErrorKind kind,
            String message
    ) {
        Status status;
        if (kind == CopperRingRepository.ErrorKind.UNAUTHENTICATED
                || kind == CopperRingRepository.ErrorKind.SESSION_EXPIRED) {
            status = Status.SESSION_EXPIRED;
        } else if (kind == CopperRingRepository.ErrorKind.NOT_FOUND) {
            status = Status.EMPTY;
        } else {
            status = Status.UNAVAILABLE;
        }
        return new CopperRingUiState(screen, status, null, null, message, 0L);
    }

    public Screen screen() { return screen; }
    public Status status() { return status; }
    public List<CopperRing> rings() { return rings; }
    public CopperRing ring() { return ring; }
    public String message() { return message; }
    public long cachedAtMs() { return cachedAtMs; }
    public boolean isRetryable() {
        return status == Status.UNAVAILABLE || status == Status.OFFLINE_STALE;
    }
    public boolean hasRingContent() {
        return ring != null || !rings.isEmpty();
    }
    public boolean isArtworkOnlyContent() {
        return screen == Screen.WALK && hasRingContent();
    }
    public boolean showsRingMetrics() {
        return screen == Screen.DETAIL && hasRingContent();
    }
    public CopperRing firstRing() {
        return rings.isEmpty() ? null : rings.get(0);
    }
}
