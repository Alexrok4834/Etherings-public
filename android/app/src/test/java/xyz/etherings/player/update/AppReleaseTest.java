package xyz.etherings.player.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AppReleaseTest {
    @Test
    public void acceptsTrustedCompleteMetadataAndComparesIntegerVersionCode() throws Exception {
        AppRelease release = AppRelease.fromJson(validJson(18, false));

        assertEquals(18, release.versionCode());
        assertEquals("0.1.17", release.displayVersion());
        assertEquals(AppRelease.APK_URL, release.downloadUrl());
        assertTrue(release.isNewerThan(17));
        assertFalse(release.isNewerThan(18));
        assertFalse(release.isNewerThan(19));
    }

    @Test
    public void rejectsArbitraryDownloadHostAndMalformedHash() throws Exception {
        JSONObject arbitraryHost = validJson(18, false)
                .put("downloadUrl", "https://example.org/etherings.apk");
        JSONObject malformedHash = validJson(18, false).put("sha256", "not-a-hash");

        assertThrows(JSONException.class, () -> AppRelease.fromJson(arbitraryHost));
        assertThrows(JSONException.class, () -> AppRelease.fromJson(malformedHash));
    }

    @Test
    public void rejectsCoercedOrFractionalFieldTypes() throws Exception {
        assertThrows(JSONException.class, () -> AppRelease.fromJson(
                validJson(18, false).put("versionCode", "18")));
        assertThrows(JSONException.class, () -> AppRelease.fromJson(
                validJson(18, false).put("versionCode", 18.5d)));
        assertThrows(JSONException.class, () -> AppRelease.fromJson(
                validJson(18, false).put("required", "false")));
        assertThrows(JSONException.class, () -> AppRelease.fromJson(
                validJson(18, false).put("sizeBytes", -1)));
    }

    @Test
    public void detectsArtifactSizeAndHashMismatch() throws Exception {
        AppRelease release = AppRelease.fromJson(validJson(18, true));

        assertTrue(release.matchesArtifact(52_328_852L,
                "231FCF5E66B782939758C4DD5DC3693ED825E6447D75F3B61F1C0107DE13E180"));
        assertFalse(release.matchesArtifact(52_328_851L, release.sha256()));
        assertFalse(release.matchesArtifact(52_328_852L,
                "331fcf5e66b782939758c4dd5dc3693ed825e6447d75f3b61f1c0107de13e180"));
    }

    @Test
    public void checkedInServerMetadataIsValidAndDoesNotDowngradeCurrentBuild() throws Exception {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        Path metadata = null;
        for (int depth = 0; depth < 5 && current != null; depth++, current = current.getParent()) {
            Path candidate = current.resolve("infrastructure/android-download/release.json");
            if (Files.isRegularFile(candidate)) {
                metadata = candidate;
                break;
            }
        }
        assertTrue("release.json was not found from the Gradle working directory", metadata != null);

        AppRelease release = AppRelease.fromJson(new JSONObject(
                new String(Files.readAllBytes(metadata), StandardCharsets.UTF_8)));
        assertEquals(17, release.versionCode());
        assertFalse(release.isNewerThan(17));
        assertTrue(release.matchesArtifact(52_339_256L,
                "c9dc4a95a862e9e3e66a8a8659a95617a5bdeff3dc8ddc04ac052ff779e10ee0"));
    }

    static JSONObject validJson(int versionCode, boolean required) throws JSONException {
        return new JSONObject()
                .put("versionCode", versionCode)
                .put("displayVersion", "0.1.17")
                .put("required", required)
                .put("downloadUrl", AppRelease.APK_URL)
                .put("sizeBytes", 52_328_852L)
                .put("sha256",
                        "231fcf5e66b782939758c4dd5dc3693ed825e6447d75f3b61f1c0107de13e180");
    }
}
