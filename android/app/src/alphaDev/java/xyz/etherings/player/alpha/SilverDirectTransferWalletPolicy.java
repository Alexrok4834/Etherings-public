package xyz.etherings.player.alpha;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONObject;
import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

/** Exact one-signer Token-2022 Silver Send approval; no Marketplace call. */
final class SilverDirectTransferWalletPolicy {
    private static final String SILVER = "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX";
    private static final String MARKET = "BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j";
    private static final String TOKEN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    private static final String SYSTEM = "11111111111111111111111111111111";
    private static final String ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    private SilverDirectTransferWalletPolicy() { }

    static byte[] approvedMessage(JSONObject approved, JSONObject refreshed,
            String wallet, String mint, String recipient) throws Exception {
        JSONObject request = refreshed.getJSONObject("request");
        JSONObject terms = refreshed.getJSONObject("terms");
        JSONObject before = approved.getJSONObject("candidate");
        JSONObject candidate = refreshed.getJSONObject("candidate");
        if (!same(approved.getJSONObject("request"), request) ||
                !same(approved.getJSONObject("terms"), terms) ||
                !keys(before).equals(keys(candidate)) ||
                !mint.equals(request.getString("mintAddress")) ||
                !recipient.equals(request.getString("recipientAddress")) ||
                !mint.equals(terms.getString("mintAddress")) ||
                !recipient.equals(terms.getString("recipientAddress")) ||
                !wallet.equals(terms.getString("senderAddress")) ||
                !wallet.equals(terms.getString("networkFeePayer")) ||
                !"1".equals(terms.getString("amount")) || terms.getInt("decimals") != 0 ||
                !wallet.equals(candidate.getString("walletAddress")) ||
                !mint.equals(candidate.getString("mintAddress")) ||
                !recipient.equals(candidate.getString("recipientAddress")))
            throw new IllegalArgumentException("Silver Send intent changed");
        Set<String> refreshable = new HashSet<>(Arrays.asList(
                "messageBase64", "sizeBytes", "blockhash", "lastValidBlockHeight"));
        for (String key : keys(before))
            if (!refreshable.contains(key) &&
                    !before.get(key).toString().equals(candidate.get(key).toString()))
                throw new IllegalArgumentException("Silver Send candidate changed");
        String kind = terms.getString("kind");
        boolean box = "SILVER_BOX".equals(kind);
        if (!box && !"SILVER_RING".equals(kind))
            throw new IllegalArgumentException("Silver Send kind changed");
        boolean marketAware = terms.getBoolean("marketAware");
        int version = terms.getInt("eamVersion");
        if (version != (box ? (marketAware ? 4 : 2) : (marketAware ? 3 : 1)) ||
                version != candidate.getInt("eamVersion") ||
                marketAware != candidate.getBoolean("marketAware"))
            throw new IllegalArgumentException("Silver EAM version changed");
        String destination = AssociatedTokenAddress.derive(recipient, TOKEN, mint);
        String eam = pda(SILVER, "extra-account-metas", mint);
        String state = pda(SILVER, box ? "silver-state" : "silver-ring-state", mint);
        String lifecycle = box ? pda(SILVER, "silver-lifecycle", mint) : null;
        String listing = marketAware ? pda(MARKET, "silver-market-listing", mint) : null;
        String source = terms.getString("sourceTokenAddress");
        if (!destination.equals(terms.getString("destinationTokenAddress")) ||
                !destination.equals(candidate.getString("destinationTokenAddress")) ||
                !eam.equals(terms.getString("eamAddress")) ||
                !eam.equals(candidate.getString("eamAddress")) ||
                !source.equals(candidate.getString("sourceTokenAddress")) ||
                !terms.getString("eamSha256").equals(candidate.getString("eamSha256")) ||
                !terms.getString("eamSha256").matches("[a-f0-9]{64}") ||
                terms.getBoolean("createsRecipientAta") !=
                        candidate.getBoolean("createsRecipientAta"))
            throw new IllegalArgumentException("Silver Send accounts changed");
        byte[] message = Base64.getDecoder().decode(candidate.getString("messageBase64"));
        if (message.length + 65 != candidate.getInt("sizeBytes") ||
                message.length + 65 > 1232)
            throw new IllegalArgumentException("Silver Send packet changed");
        Cursor cursor = new Cursor(message);
        if (cursor.u8() != 1 || cursor.u8() != 0)
            throw new IllegalArgumentException("Silver Send signer changed");
        cursor.u8();
        int count = cursor.vec();
        if (count < 8 || count > 28)
            throw new IllegalArgumentException("Silver Send key count changed");
        String[] keys = new String[count];
        for (int i = 0; i < count; i++)
            keys[i] = SilverOpeningPolicy.address(cursor.bytes(32));
        if (!wallet.equals(keys[0]) || !candidate.getString("blockhash").equals(
                SilverOpeningPolicy.address(cursor.bytes(32))))
            throw new IllegalArgumentException("Silver Send fee payer/blockhash changed");
        int instructions = cursor.vec();
        if (instructions != (terms.getBoolean("createsRecipientAta") ? 2 : 1))
            throw new IllegalArgumentException("Silver Send instruction count changed");
        if (instructions == 2) require(instruction(cursor, keys), ATA,
                new String[] { wallet, destination, recipient, mint, SYSTEM, TOKEN },
                new byte[] { 1 });
        String[] accounts = box ? new String[] { source, mint, destination, wallet,
                eam, state, lifecycle } : new String[] { source, mint, destination,
                wallet, eam, state };
        if (marketAware) accounts = concat(accounts, MARKET, listing);
        accounts = concat(accounts, SILVER);
        byte[] data = new byte[10];
        data[0] = 12; data[1] = 1; // TransferChecked(amount=1, decimals=0)
        require(instruction(cursor, keys), TOKEN, accounts, data);
        if (!cursor.done()) throw new IllegalArgumentException("Silver Send trailing data");
        return message;
    }

    private static String[] concat(String[] left, String... right) {
        String[] value = Arrays.copyOf(left, left.length + right.length);
        System.arraycopy(right, 0, value, left.length, right.length);
        return value;
    }
    private static String pda(String program, String seed, String mint) {
        return AssociatedTokenAddress.deriveProgramAddress(program,
                seed.getBytes(StandardCharsets.US_ASCII),
                AssociatedTokenAddress.decode(mint));
    }
    private static Set<String> keys(JSONObject object) {
        Set<String> result = new HashSet<>();
        Iterator<String> iterator = object.keys();
        while (iterator.hasNext()) result.add(iterator.next());
        return result;
    }
    private static boolean same(JSONObject left, JSONObject right) throws Exception {
        if (!keys(left).equals(keys(right))) return false;
        for (String key : keys(left))
            if (!left.get(key).toString().equals(right.get(key).toString())) return false;
        return true;
    }
    private static void require(Instruction value, String program, String[] accounts,
            byte[] data) {
        if (!program.equals(value.program) || !Arrays.equals(accounts, value.accounts) ||
                !Arrays.equals(data, value.data))
            throw new IllegalArgumentException("Silver Send instruction changed");
    }
    private static Instruction instruction(Cursor cursor, String[] keys) {
        int program = cursor.u8(), count = cursor.vec();
        if (program >= keys.length || count > 18)
            throw new IllegalArgumentException("Silver Send instruction keys invalid");
        String[] accounts = new String[count];
        for (int i = 0; i < count; i++) {
            int index = cursor.u8();
            if (index >= keys.length) throw new IllegalArgumentException("Silver Send key invalid");
            accounts[i] = keys[index];
        }
        return new Instruction(keys[program], accounts, cursor.bytes(cursor.vec()));
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
        int offset;
        Cursor(byte[] input) { this.input = input; }
        int u8() {
            if (offset >= input.length) throw new IllegalArgumentException("Truncated Silver Send");
            return input[offset++] & 255;
        }
        int vec() {
            int value = 0;
            for (int i = 0; i < 3; i++) {
                int part = u8(); value |= (part & 127) << (i * 7);
                if ((part & 128) == 0) return value;
            }
            throw new IllegalArgumentException("Invalid Silver Send vector");
        }
        byte[] bytes(int count) {
            if (count < 0 || count > input.length - offset)
                throw new IllegalArgumentException("Truncated Silver Send");
            byte[] result = Arrays.copyOfRange(input, offset, offset + count);
            offset += count;
            return result;
        }
        boolean done() { return offset == input.length; }
    }
}
