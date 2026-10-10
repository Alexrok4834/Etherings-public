package xyz.etherings.player.alpha.wallet;

import android.content.Context;

import java.util.Arrays;

import wallet.core.jni.AnyAddress;
import wallet.core.jni.CoinType;
import wallet.core.jni.Curve;
import wallet.core.jni.HDWallet;
import wallet.core.jni.Mnemonic;
import wallet.core.jni.PrivateKey;
import xyz.etherings.player.alpha.BindingChallenge;
import xyz.etherings.player.alpha.SilverOpeningPolicy;
import org.json.JSONObject;

/** Android-only wallet material; backend binding and UI remain separate. */
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
        try (Creation creation = generate()) {
            persist(creation);
            return new Creation(creation.address, new String(creation.mnemonic));
        }
    }

    public synchronized Creation generate() throws Exception {
        if (store.exists()) throw new IllegalStateException("wallet already exists");
        HDWallet wallet = new HDWallet(128, "");
        String mnemonic = wallet.mnemonic();
        String address = address(wallet);
        return new Creation(address, mnemonic);
    }

    public synchronized void persist(Creation creation) throws Exception {
        if (store.exists()) throw new IllegalStateException("wallet already exists");
        store.save(new String(creation.mnemonic));
    }

    public synchronized boolean exists() { return store.exists(); }

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

    public synchronized char[] recoveryPhrase() throws Exception {
        return store.load().toCharArray();
    }

    public synchronized byte[] signBinding(BindingChallenge challenge, String accountId,
            String environment) throws Exception {
        if (!challenge.accountId.equals(accountId) || !challenge.environment.equals(environment) ||
                challenge.expiresAtMs <= System.currentTimeMillis())
            throw new IllegalArgumentException("Binding intent changed or expired");
        HDWallet wallet = new HDWallet(store.load(), "");
        if (!address(wallet).equals(challenge.walletAddress))
            throw new IllegalArgumentException("selected wallet does not match binding intent");
        byte[] message = challenge.message();
        PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
        try {
            byte[] signature = key.sign(message, Curve.ED25519);
            if (signature == null || signature.length != 64 ||
                    !key.getPublicKeyEd25519().verify(signature, message))
                throw new IllegalStateException("Wallet Core Ed25519 verification failed");
            return signature;
        } finally { Arrays.fill(message, (byte) 0); }
    }

    public synchronized byte[] signGatewayMessage(byte[] message,
            GatewayTransferIntent intent) throws Exception {
        new GatewayMessagePolicy(intent).validate(message);
        return signGatewayBytes(message, intent);
    }

    public synchronized byte[] signGatewayMessage(byte[] message,
            GatewayTransferIntent intent, String recipient, long confirmedSlot) throws Exception {
        new GatewayMessagePolicy(intent, recipient).validate(message, confirmedSlot);
        return signGatewayBytes(message, intent);
    }

    private byte[] signGatewayBytes(byte[] message, GatewayTransferIntent intent) throws Exception {
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

    public synchronized byte[] signSilverOpening(JSONObject candidate, SilverOpeningPolicy policy,
            String expectedAddress) throws Exception {
        byte[] message = policy.requireApprovedMessage(candidate, expectedAddress);
        try {
            HDWallet wallet = new HDWallet(store.load(), "");
            if (!address(wallet).equals(expectedAddress))
                throw new IllegalArgumentException("Selected wallet is not the bound wallet");
            PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
            byte[] signature = key.sign(message, Curve.ED25519);
            if (signature == null || signature.length != 64 ||
                    !key.getPublicKeyEd25519().verify(signature, message))
                throw new IllegalStateException("Wallet Core opening signature invalid");
            return signature;
        } finally { Arrays.fill(message, (byte) 0); }
    }

    public synchronized byte[] signCooperEruMessage(byte[] approvedMessage,
            String expectedAddress) throws Exception {
        HDWallet wallet = new HDWallet(store.load(), "");
        if (!address(wallet).equals(expectedAddress))
            throw new IllegalArgumentException("Bound Cooper wallet changed");
        PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
        byte[] signature = key.sign(approvedMessage, Curve.ED25519);
        if (signature == null || signature.length != 64 ||
                !key.getPublicKeyEd25519().verify(signature, approvedMessage))
            throw new IllegalStateException("Wallet Core Cooper signature invalid");
        return signature;
    }

    public synchronized byte[] signSilverProgressionMessage(byte[] approvedMessage,
            String expectedAddress) throws Exception {
        HDWallet wallet = new HDWallet(store.load(), "");
        if (!address(wallet).equals(expectedAddress))
            throw new IllegalArgumentException("Bound Silver wallet changed");
        PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
        byte[] signature = key.sign(approvedMessage, Curve.ED25519);
        if (signature == null || signature.length != 64 ||
                !key.getPublicKeyEd25519().verify(signature, approvedMessage))
            throw new IllegalStateException("Wallet Core Silver signature invalid");
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
