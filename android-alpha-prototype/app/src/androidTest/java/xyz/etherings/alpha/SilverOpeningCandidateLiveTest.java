package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Activity;
import android.content.Intent;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(AndroidJUnit4.class)
public final class SilverOpeningCandidateLiveTest {
    @Test public void readOnlyVerifiedAccountAndBinding() throws Exception {
        String token = new AlphaSessionStore(InstrumentationRegistry.getInstrumentation()
                .getTargetContext()).load();
        assertTrue("verified Alpha session missing", token != null);
        AlphaApi api = new AlphaApi(BuildConfig.ALPHA_API_BASE_URL);
        AlphaApi.Result me = api.get("/auth/me", token);
        AlphaApi.Result binding = api.get("/wallet", token);
        assertEquals(200, me.status);
        assertEquals(200, binding.status);
        assertEquals(new AlphaWallet(InstrumentationRegistry.getInstrumentation()
                .getTargetContext()).address(), binding.body.getString("walletAddress"));
        assertTrue(!me.body.getString("id").isEmpty());
    }

    @Test public void readOnlyPublicWalletAddressForDisposableFixture() throws Exception {
        AlphaWallet wallet = new AlphaWallet(InstrumentationRegistry.getInstrumentation()
                .getTargetContext());
        assertTrue(wallet.exists());
        Log.i("SilverOpeningProof", "publicWalletAddress=" + wallet.address());
    }

    @Test public void boundA8WalletRejectsChangedHttpCandidateBeforeSigning() throws Exception {
        Assume.assumeTrue("1".equals(InstrumentationRegistry.getArguments()
                .getString("silverCandidateLive")));
        AlphaWallet wallet = new AlphaWallet(InstrumentationRegistry.getInstrumentation()
                .getTargetContext());
        assertTrue(wallet.exists());
        String address = wallet.address();
        assertTrue("independent build-time Silver policy required",
                !BuildConfig.ALPHA_SILVER_POLICY_B64.isEmpty());
        JSONObject pinned = new JSONObject(new String(Base64.getDecoder().decode(
                BuildConfig.ALPHA_SILVER_POLICY_B64), StandardCharsets.UTF_8));
        assertEquals(address, pinned.getString("authority"));
        SilverOpeningPolicy policy = new SilverOpeningPolicy(pinned);
        SilverOpeningChainClock clock = new SilverOpeningChainClock(
                BuildConfig.ALPHA_SILVER_RPC_URL);
        String token = getProofJson("/proof/bootstrap").getString("token");
        AlphaApi api = new AlphaApi(BuildConfig.ALPHA_API_BASE_URL);
        JSONObject body = new JSONObject().put("mintAddress", pinned.getString("mint"));
        AlphaApi.Result issued = api.post("/silver/opening/candidate-intent", body, token);
        assertEquals(200, issued.status);
        SilverOpeningPolicy.Decoded decoded = policy.validateResponse(issued.body);
        assertEquals(pinned.getString("request"), decoded.request);
        clock.requireCurrent(policy, decoded, issued.body.getLong("lastValidBlockHeight"));

        byte[] message = decoded.message();
        JSONObject changed = new JSONObject(issued.body.toString());
        changed.put("messageBase64", Base64.getEncoder().encodeToString(
                changed(message, message.length - 1)));
        reject(wallet, policy, address, changed);
        changed = new JSONObject(issued.body.toString());
        changed.put("messageBase64", Base64.getEncoder().encodeToString(changed(message, 4)));
        reject(wallet, policy, address, changed);
        changed = new JSONObject(issued.body.toString());
        changed.put("mintAddress", pinned.getString("source"));
        reject(wallet, policy, address, changed);
        changed = new JSONObject(issued.body.toString());
        changed.put("cluster", "devnet");
        reject(wallet, policy, address, changed);
        AlphaApi.Result retry = api.post("/silver/opening/candidate-intent", body, token);
        assertEquals(200, retry.status);
        assertEquals(issued.body.getString("seedHex"), retry.body.getString("seedHex"));
        assertEquals(issued.body.getString("request"), retry.body.getString("request"));

        Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(),
                MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = InstrumentationRegistry.getInstrumentation().startActivitySync(intent);
        CountDownLatch canceled = new CountDownLatch(1);
        AtomicBoolean canceledSigned = new AtomicBoolean(true);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try {
                SilverOpeningApprovalDialog.show(activity, issued.body, policy, clock,
                        wallet, address, () -> {}, outcome -> {
                            canceledSigned.set(outcome);
                            canceled.countDown();
                        });
            } catch (Exception error) { canceled.countDown(); }
        });
        assertTrue("physical Silver opening cancellation not completed",
                canceled.await(90, TimeUnit.SECONDS));
        assertFalse("canceled opening was signed", canceledSigned.get());
        AlphaApi.Result fresh = api.post("/silver/opening/candidate-intent", body, token);
        assertEquals(200, fresh.status);
        assertEquals(issued.body.getString("seedHex"), fresh.body.getString("seedHex"));
        assertEquals(issued.body.getString("request"), fresh.body.getString("request"));
        CountDownLatch confirmed = new CountDownLatch(1);
        AtomicBoolean signed = new AtomicBoolean(false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try {
                SilverOpeningApprovalDialog.show(activity, fresh.body, policy, clock,
                        wallet, address, () -> {}, outcome -> {
                            signed.set(outcome);
                            confirmed.countDown();
                        });
            } catch (Exception error) { confirmed.countDown(); }
        });
        assertTrue("physical Silver opening confirmation not completed",
                confirmed.await(90, TimeUnit.SECONDS));
        assertTrue("Wallet Core did not sign after explicit confirmation", signed.get());
    }

    private static byte[] changed(byte[] input, int offset) {
        byte[] copy = Arrays.copyOf(input, input.length);
        copy[offset] ^= 1;
        return copy;
    }

    private static void reject(AlphaWallet wallet, SilverOpeningPolicy policy,
            String address, JSONObject candidate) throws Exception {
        try {
            wallet.signSilverOpening(candidate, policy, address);
            fail("altered HTTP candidate reached Wallet Core signing");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().length() > 0);
        }
    }

    private static JSONObject getProofJson(String path) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(
                BuildConfig.ALPHA_API_BASE_URL + path).openConnection();
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(8_000);
        connection.setInstanceFollowRedirects(false);
        try {
            assertEquals(200, connection.getResponseCode());
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] chunk = new byte[1024];
                int length;
                while ((length = input.read(chunk)) != -1) {
                    assertTrue(output.size() + length < 16_384);
                    output.write(chunk, 0, length);
                }
            }
            return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
        } finally { connection.disconnect(); }
    }
}
