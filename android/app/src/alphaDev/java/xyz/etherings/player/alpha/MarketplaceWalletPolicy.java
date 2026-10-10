package xyz.etherings.player.alpha;

import org.json.JSONObject;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

/** Exact Alpha Devnet Marketplace wallet approval; no generic transaction signer. */
final class MarketplaceWalletPolicy {
    private static final String MARKET = "BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j";
    private static final String SILVER = "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX";
    private static final String VAULT = "4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk";
    private static final String TOKEN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    private static final String SYSTEM = "11111111111111111111111111111111";
    private static final String LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
    private static final String COMPUTE = "ComputeBudget111111111111111111111111111111";
    private static final String ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    private static final BigInteger U64 = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);

    private MarketplaceWalletPolicy() { }

    static byte[] approvedMessage(JSONObject approved, JSONObject refreshed,
            String wallet, String mint, String action) throws Exception {
        JSONObject firstRequest = approved.getJSONObject("request");
        JSONObject request = refreshed.getJSONObject("request");
        if (!jsonEqual(firstRequest, request) ||
                !jsonEqual(approved.getJSONObject("terms"), refreshed.getJSONObject("terms")) ||
                !action.equals(request.getString("action")) ||
                !mint.equals(request.getString("mintAddress")))
            throw new IllegalArgumentException("Marketplace intent changed");
        JSONObject before = approved.getJSONObject("candidate");
        JSONObject candidate = refreshed.getJSONObject("candidate");
        Set<String> allowedRefresh = new HashSet<>(Arrays.asList(
                "messageBase64", "sizeBytes", "blockhash", "lastValidBlockHeight"));
        if (!keys(before).equals(keys(candidate)))
            throw new IllegalArgumentException("Marketplace candidate shape changed");
        for (String key : keys(before))
            if (!allowedRefresh.contains(key) && !before.get(key).toString().equals(
                    candidate.get(key).toString()))
                throw new IllegalArgumentException("Marketplace candidate changed");
        if (!wallet.equals(candidate.getString("walletAddress")) ||
                !mint.equals(candidate.getString("mintAddress")) ||
                !action.equals(candidate.getString("action")))
            throw new IllegalArgumentException("Marketplace wallet or asset changed");
        JSONObject terms = refreshed.getJSONObject("terms");
        if (!action.equals(terms.getString("action")) ||
                !mint.equals(terms.getString("mintAddress")))
            throw new IllegalArgumentException("Marketplace terms changed");
        BigInteger nonce = amount(terms.getString("nonce"));
        if (nonce.signum() <= 0) throw new IllegalArgumentException("Marketplace nonce invalid");
        byte[] message = Base64.getDecoder().decode(candidate.getString("messageBase64"));
        if (candidate.getInt("sizeBytes") != message.length + 65 ||
                candidate.getInt("sizeBytes") > 1232)
            throw new IllegalArgumentException("Marketplace packet invalid");
        Cursor cursor = new Cursor(message);
        if (cursor.u8() != 1 || cursor.u8() != 0) // one writable wallet signer
            throw new IllegalArgumentException("Marketplace signer graph changed");
        cursor.u8(); // count of readonly unsigned keys
        int count = cursor.vec();
        if (count < 4 || count > 40) throw new IllegalArgumentException("Marketplace keys invalid");
        String[] keys = new String[count];
        for (int i = 0; i < count; i++) keys[i] = SilverOpeningPolicy.address(cursor.bytes(32));
        if (!wallet.equals(keys[0]) || !new HashSet<>(Arrays.asList(keys)).contains(MARKET))
            throw new IllegalArgumentException("Marketplace fee payer/program changed");
        if (!candidate.getString("blockhash").equals(
                SilverOpeningPolicy.address(cursor.bytes(32))))
            throw new IllegalArgumentException("Marketplace blockhash changed");
        int instructionCount = cursor.vec();
        if (instructionCount != ("BUY".equals(action) ? 3 : 1))
            throw new IllegalArgumentException("Marketplace instruction count changed");
        if ("BUY".equals(action)) {
            Instruction limit = instruction(cursor, keys);
            if (!COMPUTE.equals(limit.program) || limit.accounts.length != 0 ||
                    limit.data.length != 5 || limit.data[0] != 2 ||
                    unsigned(limit.data, 1, 4).intValue() != 1_300_000)
                throw new IllegalArgumentException("Marketplace CU instruction changed");
            Instruction create = instruction(cursor, keys);
            String destination = terms.getString("destinationTokenAddress");
            requireInstruction(create, ATA, new String[] { wallet, destination, wallet,
                    mint, SYSTEM, TOKEN }, new byte[] { 1 });
        }
        Instruction market = instruction(cursor, keys);
        if (!cursor.done() || !MARKET.equals(market.program))
            throw new IllegalArgumentException("Marketplace instruction changed");
        String listing = pda(MARKET, "silver-market-listing", mint);
        String authority = pda(MARKET, "silver-market-authority");
        String state = pda(SILVER, "SILVER_RING".equals(terms.getString("kind")) ?
                "silver-ring-state" : "silver-state", mint);
        String lifecycle = "SILVER_BOX".equals(terms.getString("kind")) ?
                pda(SILVER, "silver-lifecycle", mint) : SYSTEM;
        String extra = pda(SILVER, "extra-account-metas", mint);
        if (!listing.equals(terms.getString("listingAddress")) ||
                !listing.equals(candidate.getString("listing")))
            throw new IllegalArgumentException("Marketplace listing PDA changed");
        BigInteger price = amount(terms.getString("priceLamports"));
        if (price.signum() <= 0) throw new IllegalArgumentException("Marketplace price invalid");
        if ("LIST".equals(action)) {
            if (!wallet.equals(terms.getString("sellerAddress")) ||
                    !price.equals(amount(request.getString("priceLamports"))) ||
                    !VAULT.equals(terms.getString("royaltyAddress")) ||
                    !VAULT.equals(terms.getString("platformAddress")))
                throw new IllegalArgumentException("Marketplace seller price changed");
            checkLegs(terms, price);
            requireInstruction(market, MARKET, new String[] { wallet,
                    pda(MARKET, "silver-market-config"), mint, state, lifecycle,
                    terms.getString("sourceTokenAddress"), listing, authority, extra,
                    TOKEN, SYSTEM, SILVER, programdata(SILVER), MARKET,
                    programdata(MARKET) }, data(22, price, nonce));
        } else if ("CANCEL".equals(action)) {
            if (!wallet.equals(terms.getString("sellerAddress")))
                throw new IllegalArgumentException("Marketplace seller changed");
            requireInstruction(market, MARKET, new String[] { wallet, listing,
                    terms.getString("sourceTokenAddress"), TOKEN }, data(23, nonce));
        } else if ("BUY".equals(action)) {
            if (!wallet.equals(terms.getString("buyerAddress")) ||
                    wallet.equals(terms.getString("sellerAddress")) ||
                    !VAULT.equals(terms.getString("royaltyAddress")) ||
                    !VAULT.equals(terms.getString("platformAddress")))
                throw new IllegalArgumentException("Marketplace buyer/recipients changed");
            checkLegs(terms, price);
            String destination = AssociatedTokenAddress.derive(wallet, TOKEN, mint);
            if (!destination.equals(terms.getString("destinationTokenAddress")))
                throw new IllegalArgumentException("Marketplace destination changed");
            requireInstruction(market, MARKET, new String[] { wallet,
                    terms.getString("sellerAddress"), VAULT, VAULT,
                    terms.getString("sourceTokenAddress"), destination, mint, state,
                    lifecycle, extra, listing, authority, TOKEN, SYSTEM, MARKET, SILVER },
                    data(24, nonce, price));
        } else throw new IllegalArgumentException("Marketplace action invalid");
        return message;
    }

    private static boolean jsonEqual(JSONObject a, JSONObject b) throws Exception {
        if (!keys(a).equals(keys(b))) return false;
        for (String key : keys(a))
            if (!a.get(key).toString().equals(b.get(key).toString())) return false;
        return true;
    }

    private static Set<String> keys(JSONObject value) {
        Set<String> result = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) result.add(iterator.next());
        return result;
    }

    private static void checkLegs(JSONObject terms, BigInteger price) throws Exception {
        BigInteger royalty = price.multiply(BigInteger.valueOf(400))
                .add(BigInteger.valueOf(9999)).divide(BigInteger.valueOf(10000));
        BigInteger platform = price.multiply(BigInteger.valueOf(200))
                .add(BigInteger.valueOf(9999)).divide(BigInteger.valueOf(10000));
        if (!royalty.equals(amount(terms.getString("royaltyLamports"))) ||
                !platform.equals(amount(terms.getString("platformLamports"))) ||
                !price.add(royalty).add(platform).equals(
                        amount(terms.getString("buyerDebitLamports"))))
            throw new IllegalArgumentException("Marketplace SOL legs changed");
    }

    private static BigInteger amount(String value) {
        if (!value.matches("(0|[1-9][0-9]*)"))
            throw new IllegalArgumentException("Invalid lamports");
        BigInteger result = new BigInteger(value);
        if (result.compareTo(U64) > 0) throw new IllegalArgumentException("Lamports overflow");
        return result;
    }

    private static String pda(String program, String seed, String... keys) {
        byte[][] parts = new byte[keys.length + 1][];
        parts[0] = seed.getBytes(StandardCharsets.US_ASCII);
        for (int i = 0; i < keys.length; i++)
            parts[i + 1] = AssociatedTokenAddress.decode(keys[i]);
        return AssociatedTokenAddress.deriveProgramAddress(program, parts);
    }

    private static String programdata(String program) {
        return AssociatedTokenAddress.deriveProgramAddress(LOADER,
                AssociatedTokenAddress.decode(program));
    }

    private static byte[] data(int opcode, BigInteger... values) {
        byte[] bytes = new byte[1 + values.length * 8];
        bytes[0] = (byte) opcode;
        for (int i = 0; i < values.length; i++) {
            BigInteger value = values[i];
            for (int j = 0; j < 8; j++) {
                bytes[1 + i * 8 + j] = value.and(BigInteger.valueOf(255)).byteValue();
                value = value.shiftRight(8);
            }
        }
        return bytes;
    }

    private static BigInteger unsigned(byte[] bytes, int offset, int length) {
        byte[] big = new byte[length + 1];
        for (int i = 0; i < length; i++) big[length - i] = bytes[offset + i];
        return new BigInteger(big);
    }

    private static Instruction instruction(Cursor cursor, String[] keys) {
        int program = cursor.u8();
        int count = cursor.vec();
        if (program >= keys.length || count > 24)
            throw new IllegalArgumentException("Marketplace instruction keys invalid");
        String[] accounts = new String[count];
        for (int i = 0; i < count; i++) {
            int index = cursor.u8();
            if (index >= keys.length) throw new IllegalArgumentException("Marketplace key index invalid");
            accounts[i] = keys[index];
        }
        return new Instruction(keys[program], accounts, cursor.bytes(cursor.vec()));
    }

    private static void requireInstruction(Instruction actual, String program,
            String[] accounts, byte[] data) {
        if (!program.equals(actual.program) ||
                !Arrays.equals(accounts, actual.accounts) ||
                !Arrays.equals(data, actual.data))
            throw new IllegalArgumentException("Marketplace signed instruction changed");
    }

    private static final class Instruction {
        final String program;
        final String[] accounts;
        final byte[] data;
        Instruction(String program, String[] accounts, byte[] data) {
            this.program = program; this.accounts = accounts; this.data = data;
        }
    }

    private static final class Cursor {
        final byte[] input;
        int position;
        Cursor(byte[] input) { this.input = input; }
        int u8() {
            if (position >= input.length) throw new IllegalArgumentException("Truncated marketplace message");
            return input[position++] & 255;
        }
        int vec() {
            int value = 0;
            for (int i = 0; i < 3; i++) {
                int part = u8();
                value |= (part & 127) << (i * 7);
                if ((part & 128) == 0) return value;
            }
            throw new IllegalArgumentException("Invalid marketplace vector");
        }
        byte[] bytes(int count) {
            if (count < 0 || count > input.length - position)
                throw new IllegalArgumentException("Truncated marketplace message");
            byte[] result = Arrays.copyOfRange(input, position, position + count);
            position += count;
            return result;
        }
        boolean done() { return position == input.length; }
    }
}
