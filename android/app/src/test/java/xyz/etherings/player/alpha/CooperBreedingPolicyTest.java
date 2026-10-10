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
public final class CooperBreedingPolicyTest {
    private static final String FIRST = "33333333-3333-4333-8333-333333333333";
    private static final String SECOND = "44444444-4444-4444-8444-444444444444";
    private static final String WALLET = "CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX";
    private static final String MESSAGE =
            "AgELGqbfHq/BaBtakKBeu0+EDUMGemZqeNBNjqCWw1bQFousS3zzC/eC5SDjybzwHezKVxa8KG3L39U6vOWSh3xUsEAVq5PD8qo8WcCEO7dEcjEOwD6sW5nnKg6RURQ8hlf+yDbNOygaaNA0ddY6AMnAjrBfBX5CMnfvcVOtIeFipHrvMnNLEwJU2wS3nSxos8zx1TGrBHXJBxiyZVOuVu65v0Q+/rXGJZdaW4M4c26ITJEA9b9LaQsKBu0slLTq2wDM5lRx8DYh7JsbB6cfVnlkUZTXvB4/Z1g1x73+uf3KD6eTYe9nLtkOK8d4CfeirBBfW1WIJDbmIf1pqyde3pjqMvxdl154K0QxC1ePrm+Di+FaQzY6Utjl9op8bh8FvnjWNmQdT4iYOOeBb4T17vIVXCFiy6oBkwxKMLV91WFLx9ndaiXJbxmNoErHbr6SUtzYwbiGTHsPDL5X42dl0hTYBwawvqRvoiCNSpy08dP/NY8OAeEt1pux//O+4BqHMsTv28uwwVUuoD7MtvF5odgISqJZkES8VvUa+XdReo/Ul83B3HON8vgG50LRPx2n75yxseppbCP//R4o2to4AJ4Rjvjl4jNKtW4sqlgHJPBYrEK33kT3GWqDm0exjeH+Ke7YiQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIdmfvH3dJQpBoz8+Q6miXwecbt9OzTk48WxqF38CBWkqzN8zZ/XGlmkxDntj83Q2gb3liaAsQ8sWn7/9v72BKiSQ7hhh0MDsFUt03pcx6AGwMV5gvzP8kfEGVUGddv7/P4CoDToIf1fL7rYPLh8e7fCSrHbcEg3NKHP09LalFE+cDRJ6AsL7QmtFYmtodC1DyojBfpqW0CADUMLb/qNdIQMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAA2T8FoQ5qcrm9WjF8OW+G5SYQ7w4+Zi/QbZv22+2jmyDys6eRdP+IitjEmWYHS+MWLKvjcUqWulkFCuuyLMdNAwan1RcYe9FmNdrUBFX9wsDBJMaPIVZ1pdu6y18IAAAABt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIVAAUCwFwVABYaDgILCwABBBQYGRMHAA8GCREXDAMKEhAIDQV8BQCsI/wGAAAAAQAAAAAAAADoAwAAAAAAACIiIiIiIkIigiIiIiIiIiJVVVVVVVVFVYVVVVVVVVVVERERERERQRGBERERERERETMzMzMzM0MzgzMzMzMzMzNERERERERERIREREREREREAACWAAAAAAAAAAEAAAAAAAAAAQ==";

    private static JSONObject review() throws Exception {
        JSONObject candidate = new JSONObject()
                .put("messageBase64", MESSAGE).put("sizeBytes", 1159)
                .put("intentDigest", "1163ec53a0a9a0cfffa648134c5ea15fe1c608ddd1bb9b29be924c12c88eadaf")
                .put("operationId", "22222222-2222-4222-8222-222222222222")
                .put("reservationId", "55555555-5555-4555-8555-555555555555")
                .put("issuanceId", "aeb9d33de3045638b4b748afbd0e64cd0bfef121a451a49124104aa08d204377")
                .put("walletAddress", WALLET)
                .put("attestorAddress", "65g5pwTFDqXKKHaTfFQ2etKX8iPSTVFbUkZRoPJfXQfy")
                .put("gatewayProgramId", "Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF")
                .put("silverProgramId", "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX")
                .put("cluster", "devnet")
                .put("genesisHash", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
                .put("nonce", 1).put("configEpoch", "1").put("expirySlot", 1000);
        JSONObject terms = new JSONObject()
                .put("operationId", candidate.getString("operationId"))
                .put("reservationId", candidate.getString("reservationId"))
                .put("issuanceId", candidate.getString("issuanceId"))
                .put("walletAddress", WALLET).put("firstRingId", FIRST)
                .put("secondRingId", SECOND).put("firstUses", 0).put("secondUses", 0)
                .put("ertExact", "150").put("eruPrincipalExact", "30.000000000")
                .put("eruFeeExact", "0.600000000")
                .put("eruTotalExact", "30.600000000")
                .put("mintAddress", "2TbJiPQG2WfaDSwmpwmNwe4r9fkTWTaviwQMVhDa4PCj")
                .put("treasuryAddress", "CtwMsXbSWhw4FVJVtPGv3vv1CbnEtkmPrHhuzfUzQHGn")
                .put("intentDigest", candidate.getString("intentDigest"));
        return new JSONObject().put("candidate", candidate).put("terms", terms);
    }

    @Test public void exactCandidatePassesAndChangedEconomicsFail() throws Exception {
        JSONObject approved = review();
        JSONObject refreshed = review();
        assertEquals(1030, CooperBreedingPolicy.approvedMessage(approved, refreshed,
                FIRST, SECOND, WALLET).length);
        refreshed.getJSONObject("terms").put("ertExact", "200");
        assertThrows(IllegalArgumentException.class,
                () -> CooperBreedingPolicy.approvedMessage(approved, refreshed,
                        FIRST, SECOND, WALLET));
        assertThrows(IllegalArgumentException.class,
                () -> CooperBreedingPolicy.approvedMessage(approved, approved,
                        SECOND, FIRST, WALLET));
    }
}
