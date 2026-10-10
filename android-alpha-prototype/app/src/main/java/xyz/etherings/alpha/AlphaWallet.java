package xyz.etherings.alpha;

import android.content.Context;
import org.json.JSONObject;

import java.util.Arrays;

import wallet.core.jni.AnyAddress;
import wallet.core.jni.CoinType;
import wallet.core.jni.Curve;
import wallet.core.jni.HDWallet;
import wallet.core.jni.Mnemonic;
import wallet.core.jni.PrivateKey;

final class AlphaWallet {
    static final String DERIVATION_PATH = "m/44'/501'/0'/0'";
    private final AlphaWalletStore store;

    static { System.loadLibrary("TrustWalletCore"); }

    AlphaWallet(Context context) {
        store = new AlphaWalletStore(context.getApplicationContext());
    }

    synchronized Creation generate() throws Exception {
        if (store.exists()) throw new IllegalStateException("wallet already exists");
        HDWallet wallet = new HDWallet(128, "");
        String mnemonic = wallet.mnemonic();
        String address = address(wallet);
        return new Creation(address, mnemonic);
    }

    synchronized void persist(Creation creation) throws Exception {
        if (store.exists()) throw new IllegalStateException("wallet already exists");
        store.save(new String(creation.mnemonic));
    }

    synchronized String restore(char[] phrase) throws Exception {
        if (store.exists()) throw new IllegalStateException("wallet already exists");
        String mnemonic = new String(phrase).trim();
        if (!Mnemonic.isValid(mnemonic)) throw new IllegalArgumentException("Invalid BIP-39 phrase");
        HDWallet wallet = new HDWallet(mnemonic, "");
        String address = address(wallet);
        store.save(mnemonic);
        return address;
    }

    synchronized String address() throws Exception {
        return address(new HDWallet(store.load(), ""));
    }

    synchronized boolean exists() { return store.exists(); }

    synchronized byte[] signBinding(BindingChallenge challenge, String accountId,
            String environment) throws Exception {
        if (!challenge.accountId.equals(accountId) || !challenge.environment.equals(environment) ||
                challenge.expiresAtMs <= System.currentTimeMillis())
            throw new IllegalArgumentException("Binding intent changed or expired");
        HDWallet wallet = new HDWallet(store.load(), "");
        if (!address(wallet).equals(challenge.walletAddress))
            throw new IllegalArgumentException("Selected wallet changed");
        PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
        byte[] message = challenge.message();
        byte[] signature = key.sign(message, Curve.ED25519);
        if (signature == null || signature.length != 64 ||
                !key.getPublicKeyEd25519().verify(signature, message))
            throw new IllegalStateException("Wallet Core signature verification failed");
        return signature;
    }

    synchronized byte[] signGateway(GatewayMessagePolicy.Decoded approved,
            String expectedAddress) throws Exception {
        HDWallet wallet = new HDWallet(store.load(), "");
        if (!address(wallet).equals(expectedAddress))
            throw new IllegalArgumentException("Selected wallet is not the bound wallet");
        PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
        byte[] message = approved.message();
        try {
            byte[] signature = key.sign(message, Curve.ED25519);
            if (signature == null || signature.length != 64 ||
                    !key.getPublicKeyEd25519().verify(signature, message))
                throw new IllegalStateException("Wallet Core transaction signature invalid");
            return signature;
        } finally { Arrays.fill(message, (byte) 0); }
    }

    synchronized byte[] signSilver(SilverTransferPolicy.Decoded approved,
            String expectedAddress) throws Exception {
        HDWallet wallet = new HDWallet(store.load(), "");
        if (!address(wallet).equals(expectedAddress))
            throw new IllegalArgumentException("Selected wallet is not the bound wallet");
        PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
        byte[] message = approved.message();
        try {
            byte[] signature = key.sign(message, Curve.ED25519);
            if (signature == null || signature.length != 64 ||
                    !key.getPublicKeyEd25519().verify(signature, message))
                throw new IllegalStateException("Wallet Core signature verification failed");
            return signature;
        } finally { Arrays.fill(message, (byte) 0); }
    }

    synchronized byte[] signSilverOpening(JSONObject candidate, SilverOpeningPolicy pinnedPolicy,
            String expectedAddress) throws Exception {
        SilverOpeningPolicy.Decoded approved = pinnedPolicy.validateResponse(candidate);
        if (!approved.authority.equals(expectedAddress))
            throw new IllegalArgumentException("Opening authority is not the bound wallet");
        HDWallet wallet = new HDWallet(store.load(), "");
        if (!address(wallet).equals(expectedAddress))
            throw new IllegalArgumentException("Selected wallet is not the bound wallet");
        PrivateKey key = wallet.getKey(CoinType.SOLANA, DERIVATION_PATH);
        byte[] message = approved.message();
        try {
            byte[] signature = key.sign(message, Curve.ED25519);
            if (signature == null || signature.length != 64 ||
                    !key.getPublicKeyEd25519().verify(signature, message))
                throw new IllegalStateException("Wallet Core opening signature invalid");
            return signature;
        } finally { Arrays.fill(message, (byte) 0); }
    }

    synchronized void delete() throws Exception { store.delete(); }

    private static String address(HDWallet wallet) {
        return new AnyAddress(wallet.getKey(CoinType.SOLANA, DERIVATION_PATH)
                .getPublicKeyEd25519(), CoinType.SOLANA).description();
    }

    static final class Creation implements AutoCloseable {
        final String address;
        private final char[] mnemonic;

        Creation(String address, String phrase) {
            this.address = address;
            mnemonic = phrase.toCharArray();
        }

        char[] recoveryPhrase() { return Arrays.copyOf(mnemonic, mnemonic.length); }

        @Override public void close() { Arrays.fill(mnemonic, '\0'); }
    }
}
