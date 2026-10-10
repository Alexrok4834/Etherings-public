package xyz.etherings.player.alpha.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Base64;

@RunWith(RobolectricTestRunner.class)
public final class GatewayDevnetReviewTest {
    // Public unsigned message from the already confirmed Step 3 Devnet intent.
    private static final String MESSAGE = "AQAIDhKwXB6kHdafseJ+XK8BGSsURGmC7q4dvJ8uGVyrbYuPT6KIqC03DhFNrxjfRVnkjL+f/9vgc4ZvHDWzTt6x0yN4jSf9eAj4jDVJyRcsNCJ5ScFyU8BrpQKMt0Ld4c0EpY3ZDXlm/XqpooEKe1fL6PBA7KianZV0h5jWQcgHUgoiyoNEZa83lugSKyZgdP4+Tek1vVSOE9jLqjd7WHrG2SHU+ZnGuH2IvKR6almMwWr9egZIw7V2PR6i1CdawBytNwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGKj2Rzl0KZODOnJd+mXu8xOpNioAmNwmr4xMaaCZ/Scw5L2yf6KQycD96V6HQWYKHvrQEeumUvApxNUw+D6RXWfc4taE73f27Wm2jdmR8R+6z9miuiTnM/Q2mm4IaKJHaAwcioUiDEUIEcBs2C2Q3vHva8ijsLxFgMp3N2lWSAMDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAAan1RcYe9FmNdrUBFX9wsDBJMaPIVZ1pdu6y18IAAAABt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wNK8HDe59UzF4uCgFu4gG8MUcgBx4zNsu5UUynDo9YWAILAAUCwCcJAAoNAwkEAQACBwwNCAUABhkBAKwj/AYAAAABAAAAAAAAAL1d2h0AAAAA";
    private static final long HISTORICAL_SLOT = 500_849_618L;
    private static final String SEND_RECIPIENT = "11111111111111111111111111111111";
    private static final String SEND_MESSAGE = "AQAJDxKwXB6kHdafseJ+XK8BGSsURGmC7q4dvJ8uGVyrbYuPT6KIqC03DhFNrxjfRVnkjL+f/9vgc4ZvHDWzTt6x0yNmXciAG5oSPGZWYlfFKusKktJ+CMYOEmNDpxFyj0vw+3iNJ/14CPiMNUnJFyw0InlJwXJTwGulAoy3Qt3hzQSljdkNeWb9eqmigQp7V8vo8EDsqJqdlXSHmNZByAdSCiLU+ZnGuH2IvKR6almMwWr9egZIw7V2PR6i1CdawBytNwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGKj2Rzl0KZODOnJd+mXu8xOpNioAmNwmr4xMaaCZ/Scw5L2yf6KQycD96V6HQWYKHvrQEeumUvApxNUw+D6RXWfc4taE73f27Wm2jdmR8R+6z9miuiTnM/Q2mm4IaKJHaAwcioUiDEUIEcBs2C2Q3vHva8ijsLxFgMp3N2lWSAOMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WQMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAABqfVFxh70WY12tQEVf3CwMEkxo8hVnWl27rLXwgAAAAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAwwABQLAJwkACwYAAgYJBg4BAQoNBAkCAQADBw0OCAUABhkBgHyBSgAAAAALAAAAAAAAAFhnzR0AAAAA";

    private GatewayMessagePolicy policy() throws Exception {
        String json = new String(Files.readAllBytes(Paths.get(
                "src/test/resources/eru-historical-policy.json")), StandardCharsets.UTF_8);
        return new GatewayMessagePolicy(new JSONObject(json));
    }

    private byte[] message() { return Base64.getDecoder().decode(MESSAGE); }

    @Test public void acceptedMessageHasExactEconomicsAndCanBeRecheckedForSigning() throws Exception {
        GatewayMessagePolicy.Decoded decoded = policy().validate(message(), HISTORICAL_SLOT);
        assertEquals(30_000_000_000L, decoded.amountBaseUnits);
        assertEquals(600_000_000L, decoded.feeBaseUnits);
        assertEquals("EdXT16XWGS5vf1X2ezwaL5TB6ZLb5XqsMxBF439FmHmi", decoded.destination);
        assertEquals("6MrxKmPBSC8edNv7WfPb1JekAv9pDhEVs1uQt6H9uCn6", decoded.treasury);
        new GatewayMessagePolicy(decoded.intent()).validate(decoded.message());
    }

    @Test public void changedAmountSignerAccountOrAdditionalBytesRejectBeforeSigning() throws Exception {
        byte[] amount = message();
        byte[] expected = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
                .putLong(30_000_000_000L).array();
        int offset = -1;
        for (int i = 0; i <= amount.length - expected.length; i++) {
            if (Arrays.equals(Arrays.copyOfRange(amount, i, i + expected.length), expected)) {
                if (offset >= 0) throw new AssertionError("ambiguous fixture amount");
                offset = i;
            }
        }
        if (offset < 0) throw new AssertionError("fixture amount missing");
        amount[offset] ^= 1;
        assertThrows(IllegalArgumentException.class, () -> policy().validate(amount, HISTORICAL_SLOT));

        byte[] signer = message();
        signer[0] = 2;
        assertThrows(IllegalArgumentException.class, () -> policy().validate(signer, HISTORICAL_SLOT));

        byte[] extra = Arrays.copyOf(message(), message().length + 1);
        assertThrows(IllegalArgumentException.class, () -> policy().validate(extra, HISTORICAL_SLOT));
    }

    @Test public void changedDestinationTreasuryMintAndClusterRejectBeforeSigning() throws Exception {
        String json = new String(Files.readAllBytes(Paths.get(
                "src/test/resources/eru-historical-policy.json")), StandardCharsets.UTF_8);
        for (String field : new String[] { "destination", "treasury", "mint" }) {
            JSONObject changed = new JSONObject(json);
            changed.put(field, changed.getString("source"));
            assertThrows(IllegalArgumentException.class,
                    () -> new GatewayMessagePolicy(changed).validate(message(), HISTORICAL_SLOT));
        }
        JSONObject wrongCluster = new JSONObject(json).put("cluster", "local-validator");
        assertThrows(IllegalArgumentException.class, () -> new GatewayMessagePolicy(wrongCluster));
    }

    @Test public void expiredOrUnboundedWindowRejectsBeforeSigning() throws Exception {
        assertThrows(IllegalArgumentException.class,
                () -> policy().validate(message(), Long.MAX_VALUE));
        assertThrows(IllegalArgumentException.class,
                () -> policy().validate(message(), 0));
    }

    @Test public void userEnteredSendMatchesOfficialKitMessageAndRejectsMutations() throws Exception {
        JSONObject json = new JSONObject(new String(Files.readAllBytes(Paths.get(
                "src/test/resources/eru-historical-policy.json")), StandardCharsets.UTF_8));
        byte[] message = Base64.getDecoder().decode(SEND_MESSAGE);
        GatewayMessagePolicy send = new GatewayMessagePolicy(json, SEND_RECIPIENT, 1_250_000_000L);
        GatewayMessagePolicy.Decoded decoded = send.validate(message, 500_000_001L);
        assertEquals(1_250_000_000L, decoded.amountBaseUnits);
        assertEquals(25_000_000L, decoded.feeBaseUnits);
        assertEquals("7tbXbZBvohchchpL9VQgCSKGSAZZVdj9Zhqe2RA6Wrzv", decoded.destination);
        new GatewayMessagePolicy(decoded.intent(), SEND_RECIPIENT)
                .validate(message, 500_000_001L);
        assertThrows(IllegalArgumentException.class,
                () -> new GatewayMessagePolicy(decoded.intent(), SEND_RECIPIENT)
                        .validate(message, 500_000_601L));
        assertThrows(IllegalArgumentException.class, () -> new GatewayMessagePolicy(json,
                "Vote111111111111111111111111111111111111111", 1_250_000_000L)
                .validate(message, 500_000_001L));
        assertThrows(IllegalArgumentException.class, () -> new GatewayMessagePolicy(json,
                SEND_RECIPIENT, 1_000_000_000L).validate(message, 500_000_001L));
        byte[] signer = Arrays.copyOf(message, message.length);
        signer[0] = 2;
        assertThrows(IllegalArgumentException.class, () -> send.validate(signer, 500_000_001L));
        byte[] extra = Arrays.copyOf(message, message.length + 1);
        assertThrows(IllegalArgumentException.class, () -> send.validate(extra, 500_000_001L));
        JSONObject wrongMint = new JSONObject(json.toString()).put("mint", json.getString("source"));
        assertThrows(IllegalArgumentException.class, () -> new GatewayMessagePolicy(wrongMint,
                SEND_RECIPIENT, 1_250_000_000L).validate(message, 500_000_001L));
    }
}
