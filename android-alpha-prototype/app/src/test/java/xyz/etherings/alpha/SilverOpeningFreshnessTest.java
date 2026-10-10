package xyz.etherings.alpha;

import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class SilverOpeningFreshnessTest {
    private static final String GENESIS = "trusted-genesis";
    private static final String HASH = "message-blockhash";

    @Test public void acceptsOnlySameClusterAndLiveExactBlockhash() {
        SilverOpeningFreshness.require(GENESIS, GENESIS, HASH, HASH, 700, 699, true);
        SilverOpeningFreshness.require(GENESIS, GENESIS, HASH, HASH, 700, 700, true);
    }

    @Test public void rejectsUntrustedClusterAndChangedBlockhash() {
        assertThrows(IllegalArgumentException.class, () ->
                SilverOpeningFreshness.require(GENESIS, "other", HASH, HASH, 700, 600, true));
        assertThrows(IllegalArgumentException.class, () ->
                SilverOpeningFreshness.require("", GENESIS, HASH, HASH, 700, 600, true));
        assertThrows(IllegalArgumentException.class, () ->
                SilverOpeningFreshness.require(GENESIS, GENESIS, HASH, "other", 700, 600, true));
    }

    @Test public void rejectsExpiredInvalidAndMissingHeight() {
        assertThrows(IllegalArgumentException.class, () ->
                SilverOpeningFreshness.require(GENESIS, GENESIS, HASH, HASH, 700, 701, true));
        assertThrows(IllegalArgumentException.class, () ->
                SilverOpeningFreshness.require(GENESIS, GENESIS, HASH, HASH, 700, 699, false));
        assertThrows(IllegalArgumentException.class, () ->
                SilverOpeningFreshness.require(GENESIS, GENESIS, HASH, HASH, 0, 0, true));
    }
}
