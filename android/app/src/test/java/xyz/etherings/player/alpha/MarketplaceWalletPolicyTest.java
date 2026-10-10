package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class MarketplaceWalletPolicyTest {
    private static final String BUYER = "8GDQdaWsnCHinqwaSD3E6d2WbpFr2xVWa8FqF9n9w23G";
    private static final String SELLER = "CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX";
    private static final String MINT = "8f8djakwJPs1fu8HVX82Kk8jQP2VHfmCjEjyX98yDzFA";
    private static final String VAULT = "4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk";
    private static final String MESSAGE =
            "AQAJEWvnjLvQY7xJShNEziXVjTosyviyEZH+fC5zI1ERoTy3GChDdiElihYodQvmhWHdSgRgWZy0sjCQVOSoQyjmM1wdzTRSNCe5m9CJDYUEmfTjTCjkT0nuk6MT/FqMRvwGUC8cskdow3Wm1AtldUcKvqUqj4Vkc5p+HwDQBMkjZvPoMJI39JtNJ1LlbgD/c/+l9dJZYrXG+8+1OQnvPw9kBW2XgcVYCLUKwFbbadgGriZlr8lzG1b7p6qj4sIgUHe7GabfHq/BaBtakKBeu0+EDUMGemZqeNBNjqCWw1bQFous2xqshN/D49oPZ1wEAA6Gk6W8x6TetEjsvXAkvpi9dtkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACrM3zNn9caWaTEOe2PzdDaBveWJoCxDyxafv/2/vYEqccaCoet76JtwcMNwjokIz3n1kY3IL0VlY51oQgd3+fmMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WZetrOAqKSOYH0xn31771SigYb6QcQi0Ddd4Eua+arzyAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAACqc3/dduK2NGlr1VRJVKbosHpCZef5HqqqdJpOMDLyGwlwAck1SfPSnkxlyDEIfXEggv7y7w736hbVAxsZDPzxBt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wwkjf0m00nUuVuAP9z/6X10llitcb7z7U5Ce8/D2QFbQMNAAUCINYTAAsGAAcACggQAQEMEAAGBAQDBwoCAQ4FDxAIDAkRGAEAAAAAAAAAZAAAAAAAAAA=";
    private static final String LIST_MESSAGE =
            "AQALD6bfHq/BaBtakKBeu0+EDUMGemZqeNBNjqCWw1bQFousLxyyR2jDdabUC2V1Rwq+pSqPhWRzmn4fANAEySNm8+iXgcVYCLUKwFbbadgGriZlr8lzG1b7p6qj4sIgUHe7Gapzf9124rY0aWvVVElUpuiwekJl5/keqqp0mk4wMvIbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYKEN2ISWKFih1C+aFYd1KBGBZnLSyMJBU5KhDKOYzXBpBZjnNnZ6Mvl278UI3bXascLh0qckmDy0+vje2Ev3WHc00UjQnuZvQiQ2FBJn040wo5E9J7pOjE/xajEb8BlAqzN8zZ/XGlmkxDntj83Q2gb3liaAsQ8sWn7/9v72BKjSZxxgbDeTUq3sb3O3860WT7r1JN0TG2ybcqsBI/bKtccaCoet76JtwcMNwjokIz3n1kY3IL0VlY51oQgd3+fmXrazgKikjmB9MZ99e+9UooGG+kHEItA3XeBLmvmq88glwAck1SfPSnkxlyDEIfXEggv7y7w736hbVAxsZDPzx8IcMjTuB7cSfR4d5dRv0Hb/cpESViMDU3QaI/8eSVRYG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/DCSN/SbTSdS5W4A/3P/pfXSWWK1xvvPtTkJ7z8PZAVtAQsPAAYKBwUBAgwDDgQICQsNERZkAAAAAAAAAAEAAAAAAAAA";
    private static final String CANCEL_MESSAGE =
            "AQACBabfHq/BaBtakKBeu0+EDUMGemZqeNBNjqCWw1bQFousLxyyR2jDdabUC2V1Rwq+pSqPhWRzmn4fANAEySNm8+iXgcVYCLUKwFbbadgGriZlr8lzG1b7p6qj4sIgUHe7GZetrOAqKSOYH0xn31771SigYb6QcQi0Ddd4Eua+arzyBt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wwkjf0m00nUuVuAP9z/6X10llitcb7z7U5Ce8/D2QFbQEDBAACAQQJFwEAAAAAAAAA";

    private static JSONObject review() throws Exception {
        JSONObject request = new JSONObject().put("operationId",
                "22222222-2222-4222-8222-222222222222")
                .put("action", "BUY").put("mintAddress", MINT);
        JSONObject terms = new JSONObject().put("action", "BUY")
                .put("mintAddress", MINT).put("kind", "SILVER_BOX")
                .put("buyerAddress", BUYER).put("sellerAddress", SELLER)
                .put("sourceTokenAddress", "4AuYP44bDBDN29XM7ZvBsPSxVK3MQ9gPm2n5osxoipU7")
                .put("destinationTokenAddress", "FkHsq2HnyEBpFjoSP7E19RnXDvHtrakqGmxDoCK2gusE")
                .put("listingAddress", "BCRLH8a763KtTspzkrJx4S2KcP7UtE1myGizHQ4pgy7v")
                .put("nonce", "1").put("configVersion", "1")
                .put("royaltyAddress", VAULT).put("platformAddress", VAULT)
                .put("priceLamports", "100").put("royaltyLamports", "4")
                .put("platformLamports", "2").put("buyerDebitLamports", "106");
        JSONObject candidate = new JSONObject().put("messageBase64", MESSAGE)
                .put("sizeBytes", 700).put("blockhash", VAULT)
                .put("walletAddress", BUYER).put("mintAddress", MINT)
                .put("action", "BUY")
                .put("listing", "BCRLH8a763KtTspzkrJx4S2KcP7UtE1myGizHQ4pgy7v");
        return new JSONObject().put("request", request).put("terms", terms)
                .put("candidate", candidate);
    }

    @Test public void exactBuyPassesAndChangedPaymentFails() throws Exception {
        JSONObject approved = review(), refreshed = review();
        assertEquals(635, MarketplaceWalletPolicy.approvedMessage(
                approved, refreshed, BUYER, MINT, "BUY").length);
        refreshed.getJSONObject("terms").put("buyerDebitLamports", "105");
        assertThrows(IllegalArgumentException.class, () ->
                MarketplaceWalletPolicy.approvedMessage(approved, refreshed,
                        BUYER, MINT, "BUY"));
    }

    private static JSONObject sellerReview(String action) throws Exception {
        JSONObject request = new JSONObject().put("operationId",
                "22222222-2222-4222-8222-222222222222")
                .put("action", action).put("mintAddress", MINT);
        if ("LIST".equals(action)) request.put("priceLamports", "100");
        JSONObject terms = new JSONObject().put("action", action)
                .put("mintAddress", MINT).put("kind", "SILVER_BOX")
                .put("sellerAddress", SELLER)
                .put("sourceTokenAddress", "4AuYP44bDBDN29XM7ZvBsPSxVK3MQ9gPm2n5osxoipU7")
                .put("listingAddress", "BCRLH8a763KtTspzkrJx4S2KcP7UtE1myGizHQ4pgy7v")
                .put("nonce", "1").put("configVersion", "1")
                .put("priceLamports", "100");
        if ("LIST".equals(action)) terms.put("royaltyAddress", VAULT)
                .put("platformAddress", VAULT).put("royaltyLamports", "4")
                .put("platformLamports", "2").put("buyerDebitLamports", "106");
        JSONObject candidate = new JSONObject()
                .put("messageBase64", "LIST".equals(action) ? LIST_MESSAGE : CANCEL_MESSAGE)
                .put("sizeBytes", "LIST".equals(action) ? 617 : 278)
                .put("blockhash", VAULT).put("walletAddress", SELLER)
                .put("mintAddress", MINT).put("action", action)
                .put("listing", "BCRLH8a763KtTspzkrJx4S2KcP7UtE1myGizHQ4pgy7v");
        return new JSONObject().put("request", request).put("terms", terms)
                .put("candidate", candidate);
    }

    @Test public void exactListAndCancelKeepSellerApproval() throws Exception {
        assertEquals(552, MarketplaceWalletPolicy.approvedMessage(
                sellerReview("LIST"), sellerReview("LIST"), SELLER, MINT, "LIST").length);
        assertEquals(213, MarketplaceWalletPolicy.approvedMessage(
                sellerReview("CANCEL"), sellerReview("CANCEL"), SELLER, MINT, "CANCEL").length);
        assertThrows(IllegalArgumentException.class, () ->
                MarketplaceWalletPolicy.approvedMessage(sellerReview("LIST"),
                        sellerReview("LIST"), BUYER, MINT, "LIST"));
    }
}
