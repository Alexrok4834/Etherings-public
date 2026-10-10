package xyz.etherings.player.ring;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.economy.EruValue;

public final class CopperLevelPreview {
    private final int targetLevel;
    private final ErtValue ertCost;
    private final EruValue eruCost;
    private final EruValue eruBalance;
    private final boolean available;
    private final List<String> blockers;
    private final int grantedAttributePoints;
    private final int resultingUnspentAttributePoints;

    private CopperLevelPreview(
            int targetLevel,
            ErtValue ertCost,
            EruValue eruCost,
            EruValue eruBalance,
            boolean available,
            List<String> blockers,
            int grantedAttributePoints,
            int resultingUnspentAttributePoints
    ) {
        this.targetLevel = targetLevel;
        this.ertCost = ertCost;
        this.eruCost = eruCost;
        this.eruBalance = eruBalance;
        this.available = available;
        this.blockers = Collections.unmodifiableList(blockers);
        this.grantedAttributePoints = grantedAttributePoints;
        this.resultingUnspentAttributePoints = resultingUnspentAttributePoints;
    }

    public static CopperLevelPreview fromJson(JSONObject json) throws JSONException {
        JSONObject target = json.getJSONObject("target");
        JSONObject cost = json.getJSONObject("cost");
        JSONObject balances = json.getJSONObject("balances");
        JSONArray encoded = json.getJSONArray("blockers");
        List<String> blockers = new ArrayList<>();
        for (int index = 0; index < encoded.length(); index++) blockers.add(encoded.getString(index));
        return new CopperLevelPreview(target.getInt("level"),
                ErtValue.fromJson(cost, "ertExact", "ertDisplay", "ert"),
                EruValue.fromJson(cost, "eruExact", "eruDisplay", "eru"),
                EruValue.fromJson(balances, "eruExact", "eruDisplay", "eru"),
                json.getBoolean("available"), blockers, json.getInt("grantedAttributePoints"),
                target.getInt("unspentAttributePoints"));
    }

    public int targetLevel() { return targetLevel; }
    public String ertCostExact() { return ertCost.exact(); }
    public String ertCostDisplay() { return ertCost.display(); }
    public String eruCostExact() { return eruCost.exact(); }
    public String eruCostDisplay() { return eruCost.display(); }
    public boolean hasEruCost() { return !eruCost.isZero(); }
    public String eruBalanceExact() { return eruBalance.exact(); }
    public String eruBalanceDisplay() { return eruBalance.display(); }
    public boolean available() { return available; }
    public List<String> blockers() { return blockers; }
    public int grantedAttributePoints() { return grantedAttributePoints; }
    public int resultingUnspentAttributePoints() { return resultingUnspentAttributePoints; }
}
