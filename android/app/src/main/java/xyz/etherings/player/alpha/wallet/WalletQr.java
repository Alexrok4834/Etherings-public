package xyz.etherings.player.alpha.wallet;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.util.Map;

public final class WalletQr {
    private WalletQr() { }

    public static BitMatrix encodeAddress(String address, int pixels) throws WriterException {
        if (address == null || !address.matches("[1-9A-HJ-NP-Za-km-z]{32,44}") ||
                pixels < 128 || pixels > 1024) {
            throw new IllegalArgumentException("Invalid Solana receive address or QR size");
        }
        return new QRCodeWriter().encode(address, BarcodeFormat.QR_CODE, pixels, pixels,
                Map.of(EncodeHintType.MARGIN, 2));
    }
}
