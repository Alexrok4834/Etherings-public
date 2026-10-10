package xyz.etherings.player.alpha.wallet;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

public final class AssociatedTokenAddress {
    public static final String PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    private static final String ALPHABET =
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static final byte[] PDA_MARKER = "ProgramDerivedAddress".getBytes(StandardCharsets.US_ASCII);
    private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger D = BigInteger.valueOf(-121665)
            .multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);

    private AssociatedTokenAddress() { }

    public static String derive(String owner, String tokenProgram, String mint) {
        byte[] wallet = decode(owner);
        byte[] token = decode(tokenProgram);
        byte[] asset = decode(mint);
        return deriveProgramAddress(PROGRAM, wallet, token, asset);
    }

    public static String deriveProgramAddress(String programAddress, byte[]... seeds) {
        byte[] program = decode(programAddress);
        if (seeds.length > 16) throw new IllegalArgumentException("Too many PDA seeds");
        for (byte[] seed : seeds) {
            if (seed == null || seed.length > 32)
                throw new IllegalArgumentException("Invalid PDA seed");
        }
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            for (int bump = 255; bump >= 0; bump--) {
                sha.reset();
                for (byte[] seed : seeds) sha.update(seed);
                sha.update((byte) bump);
                sha.update(program);
                sha.update(PDA_MARKER);
                byte[] candidate = sha.digest();
                if (!onCurve(candidate)) return encode(candidate);
            }
        } catch (Exception error) {
            throw new IllegalStateException("ATA derivation unavailable", error);
        }
        throw new IllegalStateException("No valid ATA bump");
    }

    public static byte[] decode(String value) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Invalid Solana address");
        BigInteger number = BigInteger.ZERO;
        for (int index = 0; index < value.length(); index++) {
            int digit = ALPHABET.indexOf(value.charAt(index));
            if (digit < 0) throw new IllegalArgumentException("Invalid Solana address");
            number = number.multiply(BigInteger.valueOf(58)).add(BigInteger.valueOf(digit));
        }
        byte[] bytes = new byte[32];
        for (int index = 31; index >= 0; index--) {
            BigInteger[] part = number.divideAndRemainder(BigInteger.valueOf(256));
            bytes[index] = part[1].byteValue();
            number = part[0];
        }
        if (number.signum() != 0 || !encode(bytes).equals(value))
            throw new IllegalArgumentException("Invalid Solana address");
        return bytes;
    }

    private static boolean onCurve(byte[] compressed) {
        byte[] yBytes = Arrays.copyOf(compressed, 32);
        boolean negativeX = (yBytes[31] & 0x80) != 0;
        yBytes[31] &= 0x7f;
        for (int left = 0, right = 31; left < right; left++, right--) {
            byte temp = yBytes[left]; yBytes[left] = yBytes[right]; yBytes[right] = temp;
        }
        BigInteger y = new BigInteger(1, yBytes);
        if (y.compareTo(P) >= 0) return false;
        BigInteger y2 = y.multiply(y).mod(P);
        BigInteger denominator = D.multiply(y2).add(BigInteger.ONE).mod(P);
        if (denominator.signum() == 0) return false;
        BigInteger x2 = y2.subtract(BigInteger.ONE).multiply(denominator.modInverse(P)).mod(P);
        return x2.signum() == 0 ? !negativeX :
                x2.modPow(P.subtract(BigInteger.ONE).shiftRight(1), P).equals(BigInteger.ONE);
    }

    private static String encode(byte[] bytes) {
        int leading = 0;
        while (leading < bytes.length && bytes[leading] == 0) leading++;
        BigInteger number = new BigInteger(1, bytes);
        StringBuilder result = new StringBuilder();
        while (number.signum() > 0) {
            BigInteger[] part = number.divideAndRemainder(BigInteger.valueOf(58));
            result.append(ALPHABET.charAt(part[1].intValue()));
            number = part[0];
        }
        for (int i = 0; i < leading; i++) result.append('1');
        return result.reverse().toString();
    }
}
