package xyz.etherings.player.ring;

import org.json.JSONException;
import org.json.JSONObject;

import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.economy.EruValue;

public final class CopperLevelUpResult {
    private final String operationId;
    private final int level;
    private final ErtValue ertBalance;
    private final EruValue eruCost;
    private final EruValue eruBalance;
    private final int grantedAttributePoints;
    private final int unspentAttributePoints;

    private CopperLevelUpResult(
            String operationId, int level, ErtValue ertBalance, EruValue eruCost,
            EruValue eruBalance, int grantedAttributePoints, int unspentAttributePoints
    ) {
        this.operationId = operationId;
        this.level = level;
        this.ertBalance = ertBalance;
        this.eruCost = eruCost;
        this.eruBalance = eruBalance;
        this.grantedAttributePoints = grantedAttributePoints;
        this.unspentAttributePoints = unspentAttributePoints;
    }

    public static CopperLevelUpResult fromJson(JSONObject json) throws JSONException {
        JSONObject points = json.getJSONObject("unspentAttributePoints");
        JSONObject balances = json.getJSONObject("balances");
        JSONObject cost = json.getJSONObject("cost");
        return new CopperLevelUpResult(json.getString("operationId"),
                json.getJSONObject("level").getInt("current"),
                ErtValue.fromJson(balances,
                        "ertAfterExact", "ertAfterDisplay", "ertAfter"),
                EruValue.fromJson(cost, "eruExact", "eruDisplay", "eru"),
                EruValue.fromJson(balances, "eruAfterExact", "eruAfterDisplay", "eruAfter"),
                points.getInt("granted"), points.getInt("current"));
    }

    public String operationId() { return operationId; }
    public int level() { return level; }
    public String ertBalanceExact() { return ertBalance.exact(); }
    public String ertBalanceDisplay() { return ertBalance.display(); }
    public String eruCostExact() { return eruCost.exact(); }
    public String eruCostDisplay() { return eruCost.display(); }
    public boolean hasEruCost() { return !eruCost.isZero(); }
    public String eruBalanceExact() { return eruBalance.exact(); }
    public String eruBalanceDisplay() { return eruBalance.display(); }
    public int grantedAttributePoints() { return grantedAttributePoints; }
    public int unspentAttributePoints() { return unspentAttributePoints; }
}
