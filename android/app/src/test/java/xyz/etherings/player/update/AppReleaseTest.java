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

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

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
    public void release50NotifiesEveryEarlierPublicAlphaVersion() throws Exception {
        AppRelease release = AppRelease.fromJson(validJson(50, true));
        for (int installedCode = 42; installedCode < 50; installedCode++)
            assertTrue("Installed code " + installedCode, release.isNewerThan(installedCode));
        assertFalse(release.isNewerThan(50));
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
    public void publishedReleaseMetadataFixtureIsValidAndDoesNotDowngradeCurrentBuild() throws Exception {
        AppRelease release;
        try (InputStream metadata = getClass().getResourceAsStream("/public-alpha-release.json")) {
            assertTrue("Public release fixture is missing", metadata != null);
            release = AppRelease.fromJson(new JSONObject(
                    new String(metadata.readAllBytes(), StandardCharsets.UTF_8)));
        }
        assertEquals(50, release.versionCode());
        assertFalse(release.isNewerThan(50));
        assertTrue(release.matchesArtifact(123_050_250L,
                "724771c6307186dbcc91ecf2862ede4e23bdba63572fffed14d9198d34398998"));
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
