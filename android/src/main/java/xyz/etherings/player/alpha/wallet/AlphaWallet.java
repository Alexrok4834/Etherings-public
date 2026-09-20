package xyz.etherings.player.alpha.wallet;

import android.content.Context;

import java.util.Arrays;

import wallet.core.jni.AnyAddress;
import wallet.core.jni.CoinType;
import wallet.core.jni.Curve;
import wallet.core.jni.HDWallet;
import wallet.core.jni.Mnemonic;
import wallet.core.jni.PrivateKey;

/** Isolated Alpha wallet core. No MVP session, backend, or UI is connected to it. */
public final class AlphaWallet {
    public static final String DERIVATION_PATH = "m/44'/501'/0'/0'";
    private final AlphaWalletStore store;

    static {
        System.loadLibrary("TrustWalletCore");
    }

    public AlphaWallet(Context context) {
        store = new AlphaWalletStore(context.getApplicationContext());
    }

    public synchronized Creation create() throws Exception {
        if (store.exists()) throw new IllegalStateException("wallet already exists");
        HDWallet wallet = new HDWallet(128, "");
        String mnemonic = wallet.mnemonic();
        String address = address(wallet);
        store.save(mnemonic);
        return new Creation(address, mnemonic);
    }

    public synchronized String restoreFromMnemonic(char[] phrase) throws Exception {
        if (store.exists()) throw new IllegalStateException("wallet already exists");
        String mnemonic = new String(phrase).trim();
        if (!Mnemonic.isValid(mnemonic)) throw new IllegalArgumentException("invalid BIP-39 phrase");
        HDWallet wallet = new HDWallet(mnemonic, "");
        String address = address(wallet);
        store.save(mnemonic);
        return address;
    }

    public synchronized String address() throws Exception {
        return address(new HDWallet(store.load(), ""));
    }

    public synchronized byte[] signGatewayMessage(byte[] message,
            GatewayTransferIntent intent) throws Exception {
        new GatewayMessagePolicy(intent).validate(message);
        HDWallet wallet = new HDWallet(store.load(), "");
        if (!address(wallet).equals(intent.authority)) {
            throw new IllegalArgumentException("selected wallet does not match intent");
        }
        PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
        byte[] signature = key.sign(message, Curve.ED25519);
        if (signature == null || signature.length != 64
                || !key.getPublicKeyEd25519().verify(signature, message)) {
            throw new IllegalStateException("Wallet Core Ed25519 verification failed");
        }
        return signature;
    }

    public synchronized void delete() throws Exception {
        store.delete();
    }

    private static String address(HDWallet wallet) {
        return new AnyAddress(wallet.getKey(CoinType.SOLANA, DERIVATION_PATH)
                .getPublicKeyEd25519(), CoinType.SOLANA).description();
    }

    public static final class Creation implements AutoCloseable {
        public final String address;
        private final char[] mnemonic;

        private Creation(String address, String mnemonic) {
            this.address = address;
            this.mnemonic = mnemonic.toCharArray();
        }

        public char[] recoveryPhrase() {
            return Arrays.copyOf(mnemonic, mnemonic.length);
        }

        @Override
        public void close() {
            Arrays.fill(mnemonic, '\0');
        }
    }
}
