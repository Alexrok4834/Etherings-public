package xyz.etherings.player.ring;

public final class CopperAttributeDraft {
    private final int expectedUnspentPoints;
    private int comfort;
    private int charm;
    private int quality;
    private int luck;

    public CopperAttributeDraft(int expectedUnspentPoints) {
        if (expectedUnspentPoints < 0 || expectedUnspentPoints > CopperAttributeAllocation.MAX_POINTS) {
            throw new IllegalArgumentException("Unspent points must be from 0 to 76");
        }
        this.expectedUnspentPoints = expectedUnspentPoints;
    }

    public boolean add(int attributeIndex) {
        if (total() >= expectedUnspentPoints) return false;
        switch (attributeIndex) {
            case 0: comfort++; break;
            case 1: charm++; break;
            case 2: quality++; break;
            case 3: luck++; break;
            default: throw new IllegalArgumentException("Unknown attribute index");
        }
        return true;
    }

    public void clear() {
        comfort = 0;
        charm = 0;
        quality = 0;
        luck = 0;
    }

    public CopperAttributeAllocation allocation() {
        return new CopperAttributeAllocation(comfort, charm, quality, luck);
    }

    public int pointsFor(int attributeIndex) {
        switch (attributeIndex) {
            case 0: return comfort;
            case 1: return charm;
            case 2: return quality;
            case 3: return luck;
            default: throw new IllegalArgumentException("Unknown attribute index");
        }
    }

    public int total() { return comfort + charm + quality + luck; }
    public int expectedUnspentPoints() { return expectedUnspentPoints; }
    public boolean hasUnspentPoints() { return expectedUnspentPoints > 0; }
    public int remainingAfterConfirmation() { return expectedUnspentPoints - total(); }
    public boolean canConfirm() { return total() > 0 && total() <= expectedUnspentPoints; }
}
