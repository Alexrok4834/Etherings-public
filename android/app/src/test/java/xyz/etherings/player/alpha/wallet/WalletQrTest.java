package xyz.etherings.player.alpha.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import org.junit.Test;

public class WalletQrTest {
    private static final String ADDRESS = "7zSM3kBiPCVJCmvYYK8quXeydLTWtMNQDwPm3weQTHNe";

    @Test public void encodedAddressRoundTrips() throws Exception {
        BitMatrix qr = WalletQr.encodeAddress(ADDRESS, 320);
        int[] pixels = new int[qr.getWidth() * qr.getHeight()];
        for (int y = 0; y < qr.getHeight(); y++) {
            for (int x = 0; x < qr.getWidth(); x++) {
                pixels[y * qr.getWidth() + x] = qr.get(x, y) ? 0xff000000 : 0xffffffff;
            }
        }
        assertEquals(ADDRESS, new QRCodeReader().decode(new BinaryBitmap(
                new HybridBinarizer(new RGBLuminanceSource(qr.getWidth(), qr.getHeight(), pixels)))).getText());
    }

    @Test public void invalidAddressAndSizeAreRejected() {
        assertThrows(IllegalArgumentException.class, () -> WalletQr.encodeAddress("not-a-wallet", 320));
        assertThrows(IllegalArgumentException.class, () -> WalletQr.encodeAddress(ADDRESS, 20));
    }
}
