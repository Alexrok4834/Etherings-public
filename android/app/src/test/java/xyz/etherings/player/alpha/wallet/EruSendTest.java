package xyz.etherings.player.alpha.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;
import java.nio.charset.StandardCharsets;

public final class EruSendTest {
    private static final String MINT = "7zSM3kBiPCVJCmvYYK8quXeydLTWtMNQDwPm3weQTHNe";
    private static final String TOKEN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

    @Test public void officialKitAtaVectors() {
        assertEquals("AYiSyWmb8MFcDLgPfoQhFXw7L2H4xUFMckHwetWnsXbw",
                AssociatedTokenAddress.derive(
                        "2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc", TOKEN, MINT));
        assertEquals("7tbXbZBvohchchpL9VQgCSKGSAZZVdj9Zhqe2RA6Wrzv",
                AssociatedTokenAddress.derive("11111111111111111111111111111111", TOKEN, MINT));
        assertThrows(IllegalArgumentException.class,
                () -> AssociatedTokenAddress.derive("not-an-address", TOKEN, MINT));
    }

    @Test public void silverEscrowPdaMatchesFinalizedDevnetIdentity() {
        String mint = "2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq";
        String program = "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX";
        String authority = AssociatedTokenAddress.deriveProgramAddress(program,
                "silver-escrow".getBytes(StandardCharsets.US_ASCII),
                AssociatedTokenAddress.decode(mint));
        assertEquals("DptFEqnhGYrwajUg8H4gFquYDUYKFVgP4x7zaSzGgpR2", authority);
        assertEquals("3HfkLQ398SCaQkm6dsQuaYoou1mNaHoP6p1tXMNVYXcd",
                AssociatedTokenAddress.derive(authority, TOKEN, mint));
    }

    @Test public void exactDecimalAmountAndAdditiveFee() {
        long amount = EruSendAmount.parse("1.25");
        assertEquals(1_250_000_000L, amount);
        assertEquals(25_000_000L, EruSendAmount.fee(amount));
        assertEquals("1.25", EruSendAmount.format(amount));
        assertEquals(1L, EruSendAmount.fee(EruSendAmount.parse("0.000000001")));
        for (String bad : new String[] { "", "0", "-1", "1e2", "1.0000000001",
                "9223372037", "01", "1." }) {
            assertThrows(IllegalArgumentException.class, () -> EruSendAmount.parse(bad));
        }
    }
}
