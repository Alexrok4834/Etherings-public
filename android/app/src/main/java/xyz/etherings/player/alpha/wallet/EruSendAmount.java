package xyz.etherings.player.alpha.wallet;

import java.math.BigDecimal;
import java.math.BigInteger;

public final class EruSendAmount {
    private EruSendAmount() { }

    public static long parse(String text) {
        if (text == null || !text.matches("(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,9})?"))
            throw new IllegalArgumentException("Invalid ERU amount");
        try {
            long amount = new BigDecimal(text).movePointRight(9).longValueExact();
            if (amount <= 0) throw new IllegalArgumentException("Invalid ERU amount");
            Math.addExact(amount, fee(amount));
            return amount;
        } catch (ArithmeticException error) {
            throw new IllegalArgumentException("ERU amount exceeds supported range", error);
        }
    }

    public static long fee(long amount) {
        if (amount <= 0) throw new IllegalArgumentException("Invalid ERU amount");
        BigInteger value = BigInteger.valueOf(amount).multiply(BigInteger.valueOf(200))
                .add(BigInteger.valueOf(9_999)).divide(BigInteger.valueOf(10_000));
        if (value.compareTo(BigInteger.valueOf(Long.MAX_VALUE)) > 0)
            throw new IllegalArgumentException("ERU fee exceeds supported range");
        return value.longValue();
    }

    public static String format(long units) {
        return BigDecimal.valueOf(units, 9).stripTrailingZeros().toPlainString();
    }
}
