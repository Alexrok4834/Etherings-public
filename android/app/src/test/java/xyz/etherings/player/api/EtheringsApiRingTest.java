package xyz.etherings.player.api;

import static org.junit.Assert.assertEquals;

import org.junit.Test;
import org.json.JSONObject;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class EtheringsApiRingTest {
    @Test
    public void getsExactAuthenticatedCopperRingContracts() throws Exception {
        ServerSocket server = new ServerSocket(0, 3, InetAddress.getByName("127.0.0.1"));
        ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<List<RequestCapture>> captured = executor.submit(() -> captureRequests(server, 7));

        try {
            ApiConfig config = new ApiConfig("http://127.0.0.1:" + server.getLocalPort());
            EtheringsApi api = new EtheringsApi(new ApiClient(config), config);
            api.rings("access-token");
            api.ring("11111111-1111-4111-8111-111111111111", "access-token");
            api.equippedRing("access-token");
            JSONObject body = new JSONObject().put("expectedCurrentLevel", 1);
            api.previewLevelUp("11111111-1111-4111-8111-111111111111", body, "access-token");
            api.levelUp("11111111-1111-4111-8111-111111111111", body, "access-token");
            api.allocateAttributePoints("11111111-1111-4111-8111-111111111111", body, "access-token");
            api.equipRing("11111111-1111-4111-8111-111111111111", body, "access-token");

            List<RequestCapture> requests = captured.get();
            assertEquals("/me/rings", requests.get(0).path);
            assertEquals("/me/rings/11111111-1111-4111-8111-111111111111", requests.get(1).path);
            assertEquals("/me/rings/equipped", requests.get(2).path);
            assertEquals("/me/rings/11111111-1111-4111-8111-111111111111/level-up/preview", requests.get(3).path);
            assertEquals("/me/rings/11111111-1111-4111-8111-111111111111/level-up", requests.get(4).path);
            assertEquals("/me/rings/11111111-1111-4111-8111-111111111111/attribute-points/allocate", requests.get(5).path);
            assertEquals("/me/rings/11111111-1111-4111-8111-111111111111/equip", requests.get(6).path);
            for (int index = 0; index < requests.size(); index++) {
                assertEquals(index < 3 ? "GET" : "POST", requests.get(index).method);
                RequestCapture request = requests.get(index);
                assertEquals("Bearer access-token", request.authorization);
            }
        } finally {
            server.close();
            executor.shutdownNow();
        }
    }

    private static List<RequestCapture> captureRequests(ServerSocket server, int count) throws Exception {
        List<RequestCapture> requests = new ArrayList<>();
        for (int index = 0; index < count; index++) {
            try (Socket socket = server.accept()) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                String[] requestLine = reader.readLine().split(" ");
                String authorization = null;
                String header;
                while ((header = reader.readLine()) != null && !header.isEmpty()) {
                    if (header.toLowerCase().startsWith("authorization:")) {
                        authorization = header.substring(header.indexOf(':') + 1).trim();
                    }
                }
                requests.add(new RequestCapture(requestLine[0], requestLine[1], authorization));
                byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
                String headers = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                        + body.length + "\r\nConnection: close\r\n\r\n";
                socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
                socket.getOutputStream().write(body);
                socket.getOutputStream().flush();
            }
        }
        return requests;
    }

    private static final class RequestCapture {
        final String method;
        final String path;
        final String authorization;

        RequestCapture(String method, String path, String authorization) {
            this.method = method;
            this.path = path;
            this.authorization = authorization;
        }
    }
}
