package xyz.etherings.player.ring;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.math.BigInteger;

public final class SilverInventorySnapshot {
    private static final String ADDRESS = "[1-9A-HJ-NP-Za-km-z]{32,44}";
    private static final BigInteger MAX_U64 = new BigInteger("18446744073709551615");
    private static final BigInteger MAX_I64 = BigInteger.valueOf(Long.MAX_VALUE);
    private final List<Asset> assets;

    private SilverInventorySnapshot(List<Asset> assets) {
        this.assets = Collections.unmodifiableList(assets);
    }

    public List<Asset> assets() { return assets; }

    public static SilverInventorySnapshot empty() {
        return new SilverInventorySnapshot(Collections.emptyList());
    }

    public static SilverInventorySnapshot parse(JSONObject body) throws Exception {
        JSONArray rows = body.getJSONArray("assets");
        if (rows.length() > 100) throw new IllegalArgumentException("Silver inventory too large");
        List<Asset> parsed = new ArrayList<>();
        Set<String> mints = new HashSet<>();
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.getJSONObject(index);
            String kind = row.getString("kind");
            String mint = row.getString("mintAddress");
            String serial = row.getString("serial");
            if (!serial.matches("[1-9][0-9]{0,19}") ||
                    new BigInteger(serial).compareTo(new BigInteger("18446744073709551615")) > 0)
                throw new IllegalArgumentException("Invalid Silver serial");
            if (!mint.matches(ADDRESS) || !mints.add(mint))
                throw new IllegalArgumentException("Invalid Silver identity");
            if (kind.equals("SILVER_BOX")) {
                String issuanceId = row.getString("issuanceId");
                String lifecycle = row.getString("lifecycle");
                String cooldown = row.getString("cooldownUntilUnixSeconds");
                String openingStatus = row.optString("openingStatus", "");
                if (!issuanceId.matches("[a-f0-9]{64}") ||
                        !(lifecycle.equals("SEALED") || lifecycle.equals("OPENING")) ||
                        (lifecycle.equals("OPENING") &&
                                (!"PROGRAM_ESCROW".equals(row.getString("custody")) ||
                                 !"pending".equals(openingStatus))) ||
                        (lifecycle.equals("SEALED") && !openingStatus.isEmpty()) ||
                        !cooldown.matches("0|[1-9][0-9]*"))
                    throw new IllegalArgumentException("Invalid Silver Box state");
                String uri = row.optString("uri", "");
                String contentHash = row.optString("contentHash", "");
                parsed.add(new Asset(kind, mint, 0,
                        SilverArtworkVerifier.validUri(uri) && SilverArtworkVerifier.validHash(contentHash)
                                ? uri : null,
                        SilverArtworkVerifier.validUri(uri) && SilverArtworkVerifier.validHash(contentHash)
                                ? contentHash : null,
                        cooldown, lifecycle, openingStatus, null, serial,
                        null, null, null, null, null, null, null, null));
            } else if (kind.equals("SILVER_RING")) {
                int designId = row.getInt("designId");
                String uri = row.optString("uri", "");
                String contentHash = row.optString("contentHash", "");
                String boxMint = row.getString("boxMint");
                String openingStatus = row.optString("openingStatus", "");
                if (designId < 1 || designId > 42 ||
                        !boxMint.matches(ADDRESS) ||
                        !(openingStatus.isEmpty() || openingStatus.equals("confirmed")))
                    throw new IllegalArgumentException("Invalid Silver Ring state");
                boolean supportedMedia = SilverArtworkVerifier.validUri(uri) &&
                        SilverArtworkVerifier.validHash(contentHash);
                int level = requiredNumber(row, "level", 1, 20);
                int shine = requiredNumber(row, "shine", 100, 100);
                int earnedPoints = 6 * (level - 1);
                int unspentPoints = requiredNumber(row, "unspentPoints", 0, earnedPoints);
                int maxAttribute = 30 + earnedPoints;
                int comfort = requiredNumber(row, "comfort", 10, maxAttribute);
                int charm = requiredNumber(row, "charm", 10, maxAttribute);
                int quality = requiredNumber(row, "quality", 10, maxAttribute);
                int luck = requiredNumber(row, "luck", 10, maxAttribute);
                int generationTotal = comfort + charm + quality + luck + unspentPoints - earnedPoints;
                if (generationTotal < 40 || generationTotal > 120)
                    throw new IllegalArgumentException("Invalid Silver Ring Points conservation");
                String transferSlot = requiredChainNumber(row, "lastDirectTransferSlot", MAX_U64);
                String cooldown = requiredChainNumber(row, "cooldownUntilUnixSeconds", MAX_I64);
                if (transferSlot.equals("0") != cooldown.equals("0"))
                    throw new IllegalArgumentException("Invalid Silver Ring cooldown state");
                parsed.add(new Asset(kind, mint, designId,
                        supportedMedia ? uri : null, supportedMedia ? contentHash : null,
                        cooldown, null, openingStatus, boxMint, serial,
                        level, shine, unspentPoints, comfort, charm, quality, luck, transferSlot));
            } else {
                throw new IllegalArgumentException("Unknown Silver asset");
            }
        }
        return new SilverInventorySnapshot(parsed);
    }

    private static int requiredNumber(JSONObject row, String key, int minimum, int maximum)
            throws Exception {
        Object value = row.get(key);
        if (!(value instanceof Number) || !value.toString().matches("0|[1-9][0-9]*"))
            throw new IllegalArgumentException("Invalid Silver Ring " + key);
        int number = Integer.parseInt(value.toString());
        if (number < minimum || number > maximum)
            throw new IllegalArgumentException("Invalid Silver Ring " + key);
        return number;
    }

    private static String requiredChainNumber(JSONObject row, String key, BigInteger maximum)
            throws Exception {
        Object value = row.get(key);
        if (!(value instanceof String) || !((String) value).matches("0|[1-9][0-9]*") ||
                new BigInteger((String) value).compareTo(maximum) > 0)
            throw new IllegalArgumentException("Invalid Silver Ring " + key);
        return (String) value;
    }

    public static final class Asset {
        public final String kind;
        public final String mint;
        public final int designId;
        public final String uri;
        public final String contentHash;
        public final String cooldownUntilUnixSeconds;
        public final String lifecycle;
        public final String openingStatus;
        public final String boxMint;
        public final String serial;
        public final Integer level;
        public final Integer shine;
        public final Integer unspentPoints;
        public final Integer comfort;
        public final Integer charm;
        public final Integer quality;
        public final Integer luck;
        public final String lastDirectTransferSlot;

        private Asset(String kind, String mint, int designId, String uri, String contentHash,
                String cooldownUntilUnixSeconds,
                String lifecycle, String openingStatus, String boxMint, String serial,
                Integer level, Integer shine, Integer unspentPoints, Integer comfort,
                Integer charm, Integer quality, Integer luck, String lastDirectTransferSlot) {
            this.kind = kind;
            this.mint = mint;
            this.designId = designId;
            this.uri = uri;
            this.contentHash = contentHash;
            this.cooldownUntilUnixSeconds = cooldownUntilUnixSeconds;
            this.lifecycle = lifecycle;
            this.openingStatus = openingStatus;
            this.boxMint = boxMint;
            this.serial = serial;
            this.level = level;
            this.shine = shine;
            this.unspentPoints = unspentPoints;
            this.comfort = comfort;
            this.charm = charm;
            this.quality = quality;
            this.luck = luck;
            this.lastDirectTransferSlot = lastDirectTransferSlot;
        }

        public boolean isBox() { return kind.equals("SILVER_BOX"); }
        public boolean isOpening() { return isBox() && "OPENING".equals(lifecycle); }
    }
}
