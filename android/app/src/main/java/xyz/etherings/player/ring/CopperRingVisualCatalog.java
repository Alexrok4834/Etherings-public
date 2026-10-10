package xyz.etherings.player.ring;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import xyz.etherings.player.R;

public final class CopperRingVisualCatalog {
    public static final String VISUAL_SET_VERSION = "copper-visual-v1";
    public static final String RULESET_VERSION = "copper-rules-v1";

    private static final List<String> CODES = Collections.unmodifiableList(Arrays.asList(
            "copper_plain_polished",
            "copper_rune_rough",
            "copper_twisted",
            "copper_geometric",
            "copper_milgrain",
            "copper_leaves",
            "copper_celtic",
            "copper_filigree",
            "copper_signet"
    ));

    private CopperRingVisualCatalog() {}

    public static boolean supports(String code) {
        return code != null && CODES.contains(code);
    }

    public static int drawableFor(String code) {
        if ("copper_plain_polished".equals(code)) return R.drawable.copper_plain_polished_transparent;
        if ("copper_rune_rough".equals(code)) return R.drawable.copper_rune_rough_transparent;
        if ("copper_twisted".equals(code)) return R.drawable.copper_twisted_transparent;
        if ("copper_geometric".equals(code)) return R.drawable.copper_geometric_transparent;
        if ("copper_milgrain".equals(code)) return R.drawable.copper_milgrain_transparent;
        if ("copper_leaves".equals(code)) return R.drawable.copper_leaves_transparent;
        if ("copper_celtic".equals(code)) return R.drawable.copper_celtic_transparent;
        if ("copper_filigree".equals(code)) return R.drawable.copper_filigree_transparent;
        if ("copper_signet".equals(code)) return R.drawable.copper_signet_transparent;
        return 0;
    }

    static List<String> codes() {
        return CODES;
    }
}
