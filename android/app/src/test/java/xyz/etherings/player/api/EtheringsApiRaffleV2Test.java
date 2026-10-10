package xyz.etherings.player.api;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class EtheringsApiRaffleV2Test {
    @Test
    public void readsAuthenticatedSingularDrawPath() throws Exception {
        RequestCapture request = execute(api -> api.currentDraw("access-token"));

        assertEquals("GET", request.method);
        assertEquals("/raffle/v2/draw", request.path);
        assertEquals("Bearer access-token", request.authorization);
    }

    @Test
    public void treatsHistoryCursorAsOpaqueQueryData() throws Exception {
        RequestCapture request = execute(api -> api.drawHistory(20, "opaque+/cursor=", "access-token"));

        assertEquals("GET", request.method);
        assertEquals("/raffle/v2/history?limit=20&cursor=opaque%2B%2Fcursor%3D", request.path);
        assertEquals("Bearer access-token", request.authorization);
    }

    @Test
    public void postsExactAuthenticatedDrawCommand() throws Exception {
        JSONObject body = new JSONObject()
                .put("contractVersion", "raffle-v2")
                .put("configurationVersion", "33333333-3333-4333-8333-333333333333")
                .put("idempotencyKey", "44444444-4444-4444-8444-444444444444");

        RequestCapture request = execute(api -> api.executeDraw(body, "access-token"));

        assertEquals("POST", request.method);
        assertEquals("/raffle/v2/draw", request.path);
        assertEquals("Bearer access-token", request.authorization);
        JSONObject captured = new JSONObject(request.body);
        assertEquals("raffle-v2", captured.getString("contractVersion"));
        assertEquals(body.getString("configurationVersion"), captured.getString("configurationVersion"));
        assertEquals(body.getString("idempotencyKey"), captured.getString("idempotencyKey"));
        assertEquals(3, captured.length());
    }

    private static RequestCapture execute(Request request) throws Exception {
        ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<RequestCapture> captured = executor.submit(() -> capture(server));
        try {
            ApiConfig config = new ApiConfig("http://127.0.0.1:" + server.getLocalPort());
            request.run(new EtheringsApi(new ApiClient(config), config));
            return captured.get();
        } finally {
            server.close();
            executor.shutdownNow();
        }
    }

    private static RequestCapture capture(ServerSocket server) throws Exception {
        try (Socket socket = server.accept()) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(
                    socket.getInputStream(), StandardCharsets.UTF_8));
            String[] requestLine = reader.readLine().split(" ");
            String authorization = null;
            int contentLength = 0;
            String header;
            while ((header = reader.readLine()) != null && !header.isEmpty()) {
                if (header.toLowerCase().startsWith("authorization:")) {
                    authorization = header.substring(header.indexOf(':') + 1).trim();
                }
                if (header.toLowerCase().startsWith("content-length:")) {
                    contentLength = Integer.parseInt(header.substring(header.indexOf(':') + 1).trim());
                }
            }
            char[] requestBody = new char[contentLength];
            int offset = 0;
            while (offset < contentLength) {
                int read = reader.read(requestBody, offset, contentLength - offset);
                if (read < 0) break;
                offset += read;
            }
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            String response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                    + body.length + "\r\nConnection: close\r\n\r\n";
            OutputStream output = socket.getOutputStream();
            output.write(response.getBytes(StandardCharsets.US_ASCII));
            output.write(body);
            output.flush();
            return new RequestCapture(requestLine[0], requestLine[1], authorization,
                    new String(requestBody, 0, offset));
        }
    }

    private interface Request { void run(EtheringsApi api) throws Exception; }

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
