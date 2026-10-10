package xyz.etherings.player.ring;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class AlphaStarterSnapshot {
    private final CopperRing cooper;
    private final String silverStatus;
    private final List<CopperRing> coopers;

    public AlphaStarterSnapshot(CopperRing cooper, String silverStatus) {
        this(cooper, silverStatus, Collections.singletonList(cooper));
    }

    public AlphaStarterSnapshot(CopperRing cooper, String silverStatus,
            List<CopperRing> coopers) {
        if (cooper == null || silverStatus == null ||
                coopers == null || coopers.isEmpty() ||
                !(silverStatus.equals("awaiting_wallet") || silverStatus.equals("pending") || silverStatus.equals("unknown") ||
                  silverStatus.equals("confirmed"))) {
            throw new IllegalArgumentException("Invalid Alpha starter state");
        }
        this.cooper = cooper;
        this.silverStatus = silverStatus;
        this.coopers = Collections.unmodifiableList(new ArrayList<>(coopers));
        if (this.coopers.stream().noneMatch(ring -> ring.id().equals(cooper.id())))
            throw new IllegalArgumentException("Starter Cooper absent from inventory");
    }

    public CopperRing cooper() { return cooper; }
    public String silverStatus() { return silverStatus; }
    public List<CopperRing> coopers() { return coopers; }
    public CopperRing findCooper(String id) {
        for (CopperRing ring : coopers) if (ring.id().equals(id)) return ring;
        return null;
    }
}
