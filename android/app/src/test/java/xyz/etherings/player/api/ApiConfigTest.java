package xyz.etherings.player.api;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ApiConfigTest {
    @Test
    public void refreshTransportAllowsHttpsAndLocalDevelopmentOnly() {
        assertTrue(new ApiConfig("https://api.etherings.xyz").isSecureMobileSessionTransport());
        assertTrue(new ApiConfig("http://localhost:4000").isSecureMobileSessionTransport());
        assertTrue(new ApiConfig("http://127.0.0.1:4000").isSecureMobileSessionTransport());
        assertTrue(new ApiConfig("http://10.0.2.2:4000").isSecureMobileSessionTransport());
        assertFalse(new ApiConfig("http://192.0.2.20").isSecureMobileSessionTransport());
        assertFalse(new ApiConfig("ftp://api.etherings.xyz").isSecureMobileSessionTransport());
    }
}
