package xyz.etherings.player.raffle;

import xyz.etherings.player.economy.ErtValue;

public final class RaffleAffordability {
    private RaffleAffordability() {}

    public static boolean canAfford(ErtValue balance, ErtValue cost) {
        requireValues(balance, cost);
        return balance.compareTo(cost) >= 0;
    }

    public static String buttonLabel(ErtValue balance, ErtValue cost) {
        requireValues(balance, cost);
        if (balance.compareTo(cost) < 0) {
            String missingDisplay = cost.subtract(balance).display();
            return "0.00".equals(missingDisplay)
                    ? "Need less than 0.01 ERT"
                    : "Need " + missingDisplay + " more ERT";
        }
        return cost.isZero() ? "Draw" : "Draw for " + cost.display() + " ERT";
    }

    public static String readyButtonLabel(ErtValue balance, ErtValue cost, int attemptsRemaining) {
        if (attemptsRemaining < 0) throw new IllegalArgumentException("attempts remaining is invalid");
        return attemptsRemaining == 0 ? "No attempts left" : buttonLabel(balance, cost);
    }

    public static String attemptsLabel(int attemptsRemaining, int attemptLimit) {
        if (attemptLimit < 1 || attemptsRemaining < 0 || attemptsRemaining > attemptLimit) {
            throw new IllegalArgumentException("raffle attempts are invalid");
        }
        return attemptsRemaining + " / " + attemptLimit + " attempts left";
    }

    private static void requireValues(ErtValue balance, ErtValue cost) {
        if (balance == null || cost == null) {
            throw new IllegalArgumentException("raffle balance and cost are required");
        }
    }
}
