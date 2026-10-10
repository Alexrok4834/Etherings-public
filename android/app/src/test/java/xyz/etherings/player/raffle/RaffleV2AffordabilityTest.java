package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import xyz.etherings.player.R;
import xyz.etherings.player.economy.ErtValue;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RaffleV2AffordabilityTest {
    @Test
    public void usesPlayerFacingCopyForAcknowledgingARevealedResult() {
        Context context = ApplicationProvider.getApplicationContext();
        assertEquals("Continue", context.getString(R.string.raffle_v2_continue));
    }

    @Test
    public void affordabilityUsesExactBalanceRatherThanFlooredWholeUnits() {
        ErtValue cost = ErtValue.fromExact("10");
        ErtValue shortBalance = ErtValue.fromExact("9.999999999999999999");

        assertFalse(RaffleAffordability.canAfford(shortBalance, cost));
        assertEquals("Need less than 0.01 ERT", RaffleAffordability.buttonLabel(shortBalance, cost));
        assertTrue(RaffleAffordability.canAfford(ErtValue.fromExact("10.000000000000000001"), cost));
        assertEquals("Draw for 10.00 ERT",
                RaffleAffordability.buttonLabel(ErtValue.fromExact("10.000000000000000001"), cost));
    }

    @Test
    public void compactDrawLabelsKeepAttemptsAboveThePriceBearingAction() {
        ErtValue cost = ErtValue.fromExact("5");

        assertEquals("4 / 5 attempts left", RaffleAffordability.attemptsLabel(4, 5));
        assertEquals("Draw for 5.00 ERT", RaffleAffordability.readyButtonLabel(
                ErtValue.fromExact("20"), cost, 4));
        assertEquals("Need 2.00 more ERT", RaffleAffordability.readyButtonLabel(
                ErtValue.fromExact("3"), cost, 4));
        assertEquals("No attempts left", RaffleAffordability.readyButtonLabel(
                ErtValue.fromExact("20"), cost, 0));
    }
}
