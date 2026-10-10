package xyz.etherings.player.ring;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.file.Files;
import java.security.MessageDigest;

public final class SilverVerifiedMediaCacheTest {
    private static final String URI =
            "ipfs://bafybeichpgwqh2qo4zm7tedm7zhndw7nps3dom3fnucjbcufpq6es3knsi";

    @Test public void persistsOnlyVerifiedBytesAndRejectsMismatchOnRead() throws Exception {
        byte[] png = new byte[33];
        byte[] signature = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};
        System.arraycopy(signature, 0, png, 0, signature.length);
        png[12] = 'I'; png[13] = 'H'; png[14] = 'D'; png[15] = 'R';
        png[18] = 4; png[19] = (byte) 230;
        png[22] = 4; png[23] = (byte) 230;
        png[24] = 8; png[25] = 6;
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(png);
        StringBuilder hash = new StringBuilder();
        for (byte value : digest) hash.append(String.format("%02x", value & 255));
        java.io.File directory = Files.createTempDirectory("silver-cache").toFile();
        SilverVerifiedMediaCache cache = new SilverVerifiedMediaCache(directory);
        assertNull(cache.read(URI, hash.toString()));
        assertFalse(cache.store(URI, "0".repeat(64), "image/png", png));
        assertFalse(cache.store(URI, hash.toString(), "text/html", png));
        assertTrue(cache.store(URI, hash.toString(), "image/png", png));
        assertArrayEquals(png, cache.read(URI, hash.toString()));
        Files.write(directory.listFiles()[0].toPath(), new byte[] {1, 2, 3});
        assertNull(cache.read(URI, hash.toString()));
        assertNull(cache.read(URI, "0".repeat(64)));
    }

    @Test public void migratesVerifiedImageFromEvictableCacheIntoPersistentFiles() throws Exception {
        byte[] png = new byte[33];
        byte[] signature = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};
        System.arraycopy(signature, 0, png, 0, signature.length);
        png[12] = 'I'; png[13] = 'H'; png[14] = 'D'; png[15] = 'R';
        png[18] = 4; png[19] = (byte) 230;
        png[22] = 4; png[23] = (byte) 230;
        png[24] = 8; png[25] = 6;
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(png);
        StringBuilder hash = new StringBuilder();
        for (byte value : digest) hash.append(String.format("%02x", value & 255));
        java.io.File legacy = Files.createTempDirectory("silver-old").toFile();
        java.io.File persistent = Files.createTempDirectory("silver-new").toFile();
        assertTrue(new SilverVerifiedMediaCache(legacy).store(URI, hash.toString(), "image/png", png));
        SilverVerifiedMediaCache cache = new SilverVerifiedMediaCache(persistent, legacy);
        assertArrayEquals(png, cache.read(URI, hash.toString()));
        Files.delete(legacy.listFiles()[0].toPath());
        assertArrayEquals(png, cache.read(URI, hash.toString()));
    }
}
