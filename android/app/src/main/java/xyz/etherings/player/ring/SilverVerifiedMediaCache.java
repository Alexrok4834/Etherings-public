package xyz.etherings.player.ring;

import java.io.File;
import java.nio.file.Files;
import java.security.MessageDigest;

public final class SilverVerifiedMediaCache {
    private final File directory;
    private final File legacyDirectory;

    public SilverVerifiedMediaCache(File directory) {
        this(directory, null);
    }

    public SilverVerifiedMediaCache(File directory, File legacyDirectory) {
        this.directory = directory;
        this.legacyDirectory = legacyDirectory;
    }

    public byte[] read(String uri, String hash) {
        if (!SilverArtworkVerifier.validUri(uri) || !SilverArtworkVerifier.validHash(hash)) return null;
        byte[] current = readVerified(file(directory, uri, hash), uri, hash);
        if (current != null) return current;
        if (legacyDirectory == null) return null;
        byte[] legacy = readVerified(file(legacyDirectory, uri, hash), uri, hash);
        if (legacy != null) store(uri, hash, "image/png", legacy);
        return legacy;
    }

    private byte[] readVerified(File file, String uri, String hash) {
        try {
            if (!file.isFile() || file.length() > SilverArtworkVerifier.MAX_BYTES) return null;
            byte[] bytes = Files.readAllBytes(file.toPath());
            if (SilverArtworkVerifier.matches(uri, hash, "image/png", bytes)) return bytes;
            file.delete();
        } catch (Exception ignored) { }
        return null;
    }

    public boolean store(String uri, String hash, String mime, byte[] bytes) {
        if (!SilverArtworkVerifier.matches(uri, hash, mime, bytes)) return false;
        if (!directory.exists() && !directory.mkdirs()) return false;
        File target = file(directory, uri, hash);
        File pending = null;
        try {
            pending = File.createTempFile("silver-", ".tmp", directory);
            Files.write(pending.toPath(), bytes);
            if (target.exists() && !target.delete()) return false;
            return pending.renameTo(target);
        } catch (Exception ignored) {
            return false;
        } finally {
            if (pending != null) pending.delete();
        }
    }

    private File file(File root, String uri, String hash) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest((uri + "\n" + hash).getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            StringBuilder name = new StringBuilder();
            for (byte value : digest) name.append(String.format("%02x", value & 255));
            return new File(root, name + ".png");
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}
