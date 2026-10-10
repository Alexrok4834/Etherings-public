package xyz.etherings.player.ring;

public final class CopperRingUiText {
    private CopperRingUiText() {}

    public static String contentDescription(CopperRing ring) {
        return "Cooper ring, level " + ring.level() + ", Shine " + ring.shine();
    }
}
