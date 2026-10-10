package xyz.etherings.player.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONException;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AppReleaseClientTest {
    @Test
    public void parsesBoundedSuccessfulResponse() throws Exception {
        String body = AppReleaseTest.validJson(18, false).toString();
        AppRelease release = client(200, body, null).fetch();

        assertEquals(18, release.versionCode());
    }

    @Test
    public void rejectsRedirectMalformedAndOversizedResponses() {
        assertThrows(IOException.class, () -> client(302, "", null).fetch());
        assertThrows(JSONException.class, () -> client(200, "not-json", null).fetch());
        assertThrows(IOException.class, () -> client(200, "x".repeat(8_193), null).fetch());
    }

    @Test
    public void surfacesOfflineFailureForBackoffHandling() {
        assertThrows(IOException.class, () -> client(0, "", new IOException("offline")).fetch());
    }

    private static AppReleaseClient client(int status, String body, IOException failure) {
        return new AppReleaseClient(url -> new FakeConnection(url, status, body, failure));
    }

    private static final class FakeConnection extends HttpURLConnection {
        private final int status;
        private final byte[] body;
        private final IOException failure;

        private FakeConnection(URL url, int status, String body, IOException failure) {
            super(url);
            this.status = status;
            this.body = body.getBytes(StandardCharsets.UTF_8);
            this.failure = failure;
        }

        @Override
        public int getResponseCode() throws IOException {
            if (failure != null) throw failure;
            return status;
        }

        @Override
        public InputStream getInputStream() {
            return new ByteArrayInputStream(body);
        }

        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
    }
}
