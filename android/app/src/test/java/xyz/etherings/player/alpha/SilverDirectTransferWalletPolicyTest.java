package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class SilverDirectTransferWalletPolicyTest {
    private static final String WALLET = "CEQ1MmCwRxQRcP7ZRSPyqS4Lfv4PhmxfPMHk3fxgqhUX";
    private static final String RECIPIENT = "8GDQdaWsnCHinqwaSD3E6d2WbpFr2xVWa8FqF9n9w23G";
    private static final String MINT = "8f8djakwJPs1fu8HVX82Kk8jQP2VHfmCjEjyX98yDzFA";
    private static final String SOURCE = "4AuYP44bDBDN29XM7ZvBsPSxVK3MQ9gPm2n5osxoipU7";
    private static final String SILVER = "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX";
    private static final String TOKEN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    private static final String SYSTEM = "11111111111111111111111111111111";
    private static final String ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    private static final String BLOCKHASH = "4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk";

    private static String pda(String seed) {
        return AssociatedTokenAddress.deriveProgramAddress(SILVER,
                seed.getBytes(StandardCharsets.US_ASCII), AssociatedTokenAddress.decode(MINT));
    }
    private static void instruction(ByteArrayOutputStream out, int program,
            int[] accounts, byte[] data) throws Exception {
        out.write(program); out.write(accounts.length);
        for (int index : accounts) out.write(index);
        out.write(data.length); out.write(data);
    }
    private static JSONObject review() throws Exception {
        String destination = AssociatedTokenAddress.derive(RECIPIENT, TOKEN, MINT);
        String eam = pda("extra-account-metas");
        String[] keys = { WALLET, SOURCE, destination, pda("silver-state"),
                pda("silver-lifecycle"), eam, MINT, RECIPIENT, TOKEN,
                SILVER, ATA, SYSTEM };
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(new byte[] { 1, 0, 4, (byte) keys.length });
        for (String key : keys) out.write(AssociatedTokenAddress.decode(key));
        out.write(AssociatedTokenAddress.decode(BLOCKHASH));
        out.write(2);
        instruction(out, 10, new int[] { 0, 2, 7, 6, 11, 8 }, new byte[] { 1 });
        byte[] transfer = new byte[10]; transfer[0] = 12; transfer[1] = 1;
        instruction(out, 8, new int[] { 1, 6, 2, 0, 5, 3, 4, 9 }, transfer);
        byte[] message = out.toByteArray();
        JSONObject request = new JSONObject().put("operationId",
                "22222222-2222-4222-8222-222222222222")
                .put("mintAddress", MINT).put("recipientAddress", RECIPIENT);
        JSONObject terms = new JSONObject().put("kind", "SILVER_BOX")
                .put("mintAddress", MINT).put("senderAddress", WALLET)
                .put("recipientAddress", RECIPIENT).put("sourceTokenAddress", SOURCE)
                .put("destinationTokenAddress", destination).put("amount", "1")
                .put("decimals", 0).put("networkFeePayer", WALLET)
                .put("createsRecipientAta", true).put("eamAddress", eam)
                .put("eamSha256", "0".repeat(64)).put("eamVersion", 2)
                .put("marketAware", false);
        JSONObject candidate = new JSONObject().put("messageBase64",
                Base64.getEncoder().encodeToString(message))
                .put("sizeBytes", message.length + 65).put("blockhash", BLOCKHASH)
                .put("walletAddress", WALLET).put("mintAddress", MINT)
                .put("recipientAddress", RECIPIENT).put("sourceTokenAddress", SOURCE)
                .put("destinationTokenAddress", destination)
                .put("eamAddress", eam).put("eamSha256", "0".repeat(64))
                .put("eamVersion", 2).put("marketAware", false)
                .put("createsRecipientAta", true).put("kind", "SILVER_BOX")
                .put("lastValidBlockHeight", 123);
        return new JSONObject().put("request", request).put("terms", terms)
                .put("candidate", candidate);
    }

    @Test public void exactSendPassesAndChangedMintOrRecipientFails() throws Exception {
        JSONObject approved = review(), refreshed = review();
        assertEquals(approved.getJSONObject("candidate").getInt("sizeBytes") - 65,
                SilverDirectTransferWalletPolicy.approvedMessage(approved, refreshed,
                        WALLET, MINT, RECIPIENT).length);
        assertThrows(IllegalArgumentException.class, () ->
                SilverDirectTransferWalletPolicy.approvedMessage(approved, refreshed,
                        WALLET, MINT, WALLET));
        assertThrows(IllegalArgumentException.class, () ->
                SilverDirectTransferWalletPolicy.approvedMessage(approved, refreshed,
                        WALLET, RECIPIENT, RECIPIENT));
    }

    @Test public void changedAmountAndUnexpectedMarketplaceProgramFail() throws Exception {
        JSONObject approved = review(), refreshed = review();
        JSONObject candidate = refreshed.getJSONObject("candidate");
        byte[] message = Base64.getDecoder().decode(candidate.getString("messageBase64"));
        message[message.length - 9] = 2;
        candidate.put("messageBase64", Base64.getEncoder().encodeToString(message));
        assertThrows(IllegalArgumentException.class, () ->
                SilverDirectTransferWalletPolicy.approvedMessage(approved, refreshed,
                        WALLET, MINT, RECIPIENT));
        JSONObject wrong = review();
        wrong.getJSONObject("terms").put("marketAware", true);
        assertThrows(IllegalArgumentException.class, () ->
                SilverDirectTransferWalletPolicy.approvedMessage(approved, wrong,
                        WALLET, MINT, RECIPIENT));
    }
}
