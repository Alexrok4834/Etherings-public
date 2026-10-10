package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class CopperLevelModelsTest {
    @Test
    public void allocationAcceptsPartialConfirmedPoints() throws Exception {
        CopperAttributeAllocation allocation = new CopperAttributeAllocation(2, 0, 0, 0);
        assertEquals(2, allocation.toJson().getInt("comfort"));
        assertEquals(0, allocation.toJson().getInt("luck"));
        assertEquals(2, allocation.total());
    }

    @Test
    public void allocationAcceptsAllAccumulatedPointsInOneConfirmation() throws Exception {
        CopperAttributeAllocation allocation = new CopperAttributeAllocation(20, 16, 30, 10);
        assertEquals(76, allocation.total());
        assertEquals(30, allocation.toJson().getInt("quality"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void allocationRejectsMoreThanContractMaximum() {
        new CopperAttributeAllocation(76, 1, 0, 0);
    }

    @Test
    public void draftRetainsAccumulatedRemainderUntilExplicitClearOrConfirmation() {
        CopperAttributeDraft draft = new CopperAttributeDraft(9);
        assertTrue(draft.hasUnspentPoints());
        assertTrue(draft.add(0));
        assertTrue(draft.add(0));
        assertTrue(draft.add(3));
        assertEquals(3, draft.total());
        assertEquals(6, draft.remainingAfterConfirmation());
        assertTrue(draft.canConfirm());
        draft.clear();
        assertEquals(0, draft.total());
        assertFalse(draft.canConfirm());
    }

    @Test
    public void draftCapsConfirmationAtAuthoritativeBalance() {
        CopperAttributeDraft accumulated = new CopperAttributeDraft(10);
        for (int index = 0; index < 10; index++) {
            assertTrue(accumulated.add(index % 4));
        }
        assertEquals(10, accumulated.total());
        assertEquals(0, accumulated.remainingAfterConfirmation());
        assertFalse(accumulated.add(0));
        assertEquals(10, accumulated.allocation().total());

        CopperAttributeDraft two = new CopperAttributeDraft(2);
        assertTrue(two.add(0));
        assertTrue(two.add(0));
        assertFalse(two.add(0));

        CopperAttributeDraft empty = new CopperAttributeDraft(0);
        assertFalse(empty.hasUnspentPoints());
        assertFalse(empty.add(0));
    }

    @Test
    public void draftSupportsTwoDigitSelectionsAndAll76PointsWithoutChangingTheLimit() {
        CopperAttributeDraft draft = new CopperAttributeDraft(76);
        for (int index = 0; index < 76; index++) {
            assertTrue(draft.add(index < 37 ? 0 : 1));
        }
        assertEquals(37, draft.pointsFor(0));
        assertEquals(39, draft.pointsFor(1));
        assertEquals(76, draft.total());
        assertEquals(0, draft.remainingAfterConfirmation());
        assertTrue(draft.canConfirm());
        assertFalse(draft.add(2));
        assertEquals(76, draft.allocation().total());
    }

    @Test
    public void parsesAuthoritativePreviewAndCommittedResult() throws Exception {
        CopperLevelPreview preview = CopperLevelPreview.fromJson(new JSONObject()
                .put("target", new JSONObject().put("level", 5).put("unspentAttributePoints", 12))
                .put("grantedAttributePoints", 4)
                .put("cost", new JSONObject().put("ert", 24)
                        .put("ertExact", "24").put("ertDisplay", "24.00")
                        .put("eru", JSONObject.NULL).put("eruExact", "9007199254740993")
                        .put("eruDisplay", "9007199254740993"))
                .put("balances", new JSONObject().put("eru", JSONObject.NULL)
                        .put("eruExact", "9007199254741000")
                        .put("eruDisplay", "9007199254741000"))
                .put("available", false)
                .put("blockers", new JSONArray().put("INSUFFICIENT_ERU")));
        assertEquals(5, preview.targetLevel());
        assertEquals("24", preview.ertCostExact());
        assertEquals("24.00", preview.ertCostDisplay());
        assertEquals("9007199254740993", preview.eruCostExact());
        assertEquals("9007199254740993.00", preview.eruCostDisplay());
        assertEquals("9007199254741000", preview.eruBalanceExact());
        assertEquals("9007199254741000.00", preview.eruBalanceDisplay());
        assertFalse(preview.available());
        assertEquals(4, preview.grantedAttributePoints());
        assertEquals(12, preview.resultingUnspentAttributePoints());

        CopperLevelUpResult result = CopperLevelUpResult.fromJson(new JSONObject()
                .put("operationId", "11111111-1111-4111-8111-111111111111")
                .put("level", new JSONObject().put("current", 2))
                .put("unspentAttributePoints", new JSONObject().put("granted", 4).put("current", 12))
                .put("cost", new JSONObject().put("eru", JSONObject.NULL)
                        .put("eruExact", "9007199254740993")
                        .put("eruDisplay", "9007199254740993"))
                .put("balances", new JSONObject().put("ertAfter", 88)
                        .put("ertAfterExact", "88.000000000000000001")
                        .put("ertAfterDisplay", "88.00")
                        .put("eruAfter", JSONObject.NULL)
                        .put("eruAfterExact", "7")
                        .put("eruAfterDisplay", "7")));
        assertEquals(2, result.level());
        assertEquals("88.000000000000000001", result.ertBalanceExact());
        assertEquals("88.00", result.ertBalanceDisplay());
        assertEquals("9007199254740993", result.eruCostExact());
        assertEquals("9007199254740993.00", result.eruCostDisplay());
        assertEquals("7", result.eruBalanceExact());
        assertEquals("7.00", result.eruBalanceDisplay());
        assertEquals(4, result.grantedAttributePoints());
        assertEquals(12, result.unspentAttributePoints());

        CopperAttributeAllocationResult allocationResult = CopperAttributeAllocationResult.fromJson(new JSONObject()
                .put("operationId", "22222222-2222-4222-8222-222222222222")
                .put("attributes", new JSONObject().put("current", new JSONObject()
                        .put("comfort", 4).put("charm", 20).put("quality", 7).put("luck", 11)))
                .put("unspentAttributePoints", new JSONObject().put("current", 6)));
        assertEquals(4, allocationResult.comfort());
        assertEquals(6, allocationResult.unspentAttributePoints());
    }

    @Test
    public void parsesFractionalEruLevelUpValuesWithoutFloatingPoint() throws Exception {
        CopperLevelPreview preview = CopperLevelPreview.fromJson(new JSONObject()
                .put("target", new JSONObject().put("level", 5).put("unspentAttributePoints", 4))
                .put("grantedAttributePoints", 4)
                .put("cost", new JSONObject().put("ert", 24)
                        .put("ertExact", "24").put("ertDisplay", "24.00")
                        .put("eru", JSONObject.NULL).put("eruExact", "30.125")
                        .put("eruDisplay", "30.13"))
                .put("balances", new JSONObject().put("eru", JSONObject.NULL)
                        .put("eruExact", "99.999999999999999999")
                        .put("eruDisplay", "100.00"))
                .put("available", true).put("blockers", new JSONArray()));

        assertEquals("30.125", preview.eruCostExact());
        assertEquals("30.13", preview.eruCostDisplay());
        assertEquals("99.999999999999999999", preview.eruBalanceExact());
        assertEquals("100.00", preview.eruBalanceDisplay());
    }

    @Test(expected = org.json.JSONException.class)
    public void rejectsMismatchedLevelUpDisplayContract() throws Exception {
        CopperLevelUpResult.fromJson(new JSONObject()
                .put("operationId", "11111111-1111-4111-8111-111111111111")
                .put("level", new JSONObject().put("current", 2))
                .put("unspentAttributePoints", new JSONObject().put("granted", 4).put("current", 4))
                .put("cost", new JSONObject().put("eru", 0)
                        .put("eruExact", "0").put("eruDisplay", "0"))
                .put("balances", new JSONObject().put("ertAfter", 88)
                        .put("ertAfterExact", "88.005").put("ertAfterDisplay", "88.00")
                        .put("eruAfter", 0).put("eruAfterExact", "0").put("eruAfterDisplay", "0")));
    }
}
