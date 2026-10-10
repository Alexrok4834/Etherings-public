package xyz.etherings.player.alpha;

import android.content.Context;
import android.util.AtomicFile;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.UUID;

final class AlphaEruSubmissionStore {
    private final File directory;

    AlphaEruSubmissionStore(Context context) {
        this(context.getNoBackupFilesDir());
    }

    AlphaEruSubmissionStore(File directory) { this.directory = directory; }

    private AtomicFile file(String accountId) {
        if (!Marker.canonicalUuid(accountId)) throw new IllegalArgumentException("Invalid Alpha account");
        return new AtomicFile(new File(directory, "alpha-dev-eru-submission-v2-canonical-" + accountId));
    }

    synchronized boolean hasHistoricalMarker(String accountId) {
        if (!Marker.canonicalUuid(accountId)) throw new IllegalArgumentException("Invalid Alpha account");
        File legacy = new File(directory, "alpha-dev-eru-submission-v1-" + accountId);
        return legacy.exists() || new File(legacy.getPath() + ".bak").exists();
    }

    synchronized void save(String accountId, String walletAddress, String intentId) throws IOException {
        AtomicFile file = file(accountId);
        Marker current = load(accountId);
        Marker next = new Marker(accountId, walletAddress, intentId);
        if (current != null && !current.same(next))
            throw new IllegalStateException("Unresolved ERU submission exists");
        FileOutputStream output = file.startWrite();
        try {
            DataOutputStream data = new DataOutputStream(output);
            data.writeByte(1);
            data.writeUTF(accountId);
            data.writeUTF(walletAddress);
            data.writeUTF(intentId);
            data.flush();
            file.finishWrite(output);
        } catch (IOException | RuntimeException error) {
            file.failWrite(output);
            throw error;
        }
    }

    synchronized Marker load(String accountId) throws IOException {
        AtomicFile file = file(accountId);
        FileInputStream input;
        try { input = file.openRead(); }
        catch (FileNotFoundException missing) {
            if (file.getBaseFile().exists() ||
                    new File(file.getBaseFile().getPath() + ".bak").exists()) throw missing;
            return null;
        }
        try (FileInputStream opened = input; DataInputStream data = new DataInputStream(opened)) {
            if (data.readUnsignedByte() != 1) throw new IOException("Invalid ERU marker version");
            Marker marker = new Marker(data.readUTF(), data.readUTF(), data.readUTF());
            if (data.read() != -1) throw new IOException("Invalid ERU marker length");
            return marker;
        } catch (IllegalArgumentException error) {
            throw new IOException("Invalid ERU marker", error);
        }
    }

    synchronized void clearIf(String accountId, String walletAddress, String intentId) throws IOException {
        AtomicFile file = file(accountId);
        Marker marker = load(accountId);
        if (marker != null && marker.matches(accountId, walletAddress) && marker.intentId.equals(intentId))
            file.delete();
    }

    static final class Marker {
        final String accountId;
        final String walletAddress;
        final String intentId;

        Marker(String accountId, String walletAddress, String intentId) {
            if (!canonicalUuid(accountId) || !canonicalUuid(intentId) ||
                    walletAddress == null || !walletAddress.matches("[1-9A-HJ-NP-Za-km-z]{32,44}"))
                throw new IllegalArgumentException("Invalid ERU marker identity");
            this.accountId = accountId;
            this.walletAddress = walletAddress;
            this.intentId = intentId;
        }

        boolean matches(String accountId, String walletAddress) {
            return this.accountId.equals(accountId) && this.walletAddress.equals(walletAddress);
        }

        boolean same(Marker other) {
            return matches(other.accountId, other.walletAddress) && intentId.equals(other.intentId);
        }

        static boolean canonicalUuid(String value) {
            try { return value != null && value.equals(UUID.fromString(value).toString()); }
            catch (IllegalArgumentException error) { return false; }
        }
    }
}
