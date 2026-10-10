package xyz.etherings.player.api;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class EtheringsApiRegistrationTest {
    @Test
    public void postsExactMobileRegistrationContractOverAllowedLocalTestTransport() throws Exception {
        ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<RequestCapture> captured = executor.submit(() -> captureOneRequest(server, "{\"registered\":true}"));

        try {
            ApiConfig config = new ApiConfig("http://127.0.0.1:" + server.getLocalPort());
            JSONObject result = new EtheringsApi(new ApiClient(config), config).mobileRegister(
                    "new_player",
                    "secure-password",
                    "New Player",
                    "22222222-2222-4222-8222-222222222222"
            );

            RequestCapture request = captured.get();
            assertEquals("POST", request.method);
            assertEquals("/auth/mobile-register", request.path);
            assertEquals(true, result.getBoolean("registered"));
            JSONObject body = new JSONObject(request.body);
            assertEquals("new_player", body.getString("username"));
            assertEquals("secure-password", body.getString("password"));
            assertEquals("New Player", body.getString("displayName"));
            assertEquals("22222222-2222-4222-8222-222222222222", body.getString("installationId"));
            assertEquals(4, body.length());
        } finally {
            server.close();
            executor.shutdownNow();
        }
    }

    @Test
    public void getsExactAuthenticatedActivityRangeContract() throws Exception {
        ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<RequestCapture> captured = executor.submit(() -> captureOneRequest(server, "{\"days\":[]}"));

        try {
            ApiConfig config = new ApiConfig("http://127.0.0.1:" + server.getLocalPort());
            JSONObject result = new EtheringsApi(new ApiClient(config), config).activityHistory(
                    "2026-07-16",
                    "2026-08-14",
                    "access-token"
            );

            RequestCapture request = captured.get();
            assertEquals("GET", request.method);
            assertEquals("/me/activity?from=2026-07-16&to=2026-08-14", request.path);
            assertEquals("Bearer access-token", request.authorization);
            assertEquals(0, result.getJSONArray("days").length());
        } finally {
            server.close();
            executor.shutdownNow();
        }
    }

    private static RequestCapture captureOneRequest(ServerSocket server, String responseJson) throws Exception {
        try (Socket socket = server.accept()) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            String[] requestLine = reader.readLine().split(" ");
            int contentLength = 0;
            String authorization = null;
            String header;
            while ((header = reader.readLine()) != null && !header.isEmpty()) {
                if (header.toLowerCase().startsWith("content-length:")) {
                    contentLength = Integer.parseInt(header.substring(header.indexOf(':') + 1).trim());
                }
                if (header.toLowerCase().startsWith("authorization:")) {
                    authorization = header.substring(header.indexOf(':') + 1).trim();
                }
            }
            char[] body = new char[contentLength];
            int offset = 0;
            while (offset < body.length) {
                int read = reader.read(body, offset, body.length - offset);
                if (read < 0) break;
                offset += read;
            }
            byte[] responseBody = responseJson.getBytes(StandardCharsets.UTF_8);
            String headers = "HTTP/1.1 201 Created\r\n"
                    + "Content-Type: application/json\r\n"
                    + "Content-Length: " + responseBody.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().write(responseBody);
            socket.getOutputStream().flush();
            return new RequestCapture(requestLine[0], requestLine[1], authorization, new String(body, 0, offset));
        }
    }

    private static final class RequestCapture {
        final String method;
        final String path;
        final String authorization;
        final String body;

        RequestCapture(String method, String path, String authorization, String body) {
            this.method = method;
            this.path = path;
            this.authorization = authorization;
            this.body = body;
        }
    }
}
