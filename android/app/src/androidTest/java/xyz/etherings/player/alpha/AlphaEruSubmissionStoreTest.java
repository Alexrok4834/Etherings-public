package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import android.content.Context;
import android.util.AtomicFile;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;

public final class AlphaEruSubmissionStoreTest {
    private static final String A = "00000000-0000-4000-8000-000000000001";
    private static final String B = "00000000-0000-4000-8000-000000000002";
    private static final String FIRST = "00000000-0000-4000-8000-000000000003";
    private static final String SECOND = "00000000-0000-4000-8000-000000000004";
    private static final String ADDRESS = "2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc";

    @Test public void survivesRestartAndBlocksOnlyItsAccount() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File directory = new File(context.getCacheDir(), "eru-marker-test-" + System.nanoTime());
        if (!directory.mkdirs()) throw new IllegalStateException("Test directory unavailable");
        AlphaEruSubmissionStore first = new AlphaEruSubmissionStore(directory);
        try {
            first.save(A, ADDRESS, FIRST);
            AtomicFile interrupted = new AtomicFile(new File(directory,
                    "alpha-dev-eru-submission-v1-" + A));
            FileOutputStream incomplete = interrupted.startWrite();
            incomplete.write(0);
            interrupted.failWrite(incomplete);
            AlphaEruSubmissionStore restarted = new AlphaEruSubmissionStore(directory);
            assertEquals(FIRST, restarted.load(A).intentId);
            assertNull(restarted.load(B));
            assertThrows(IllegalStateException.class, () -> restarted.save(A, ADDRESS, SECOND));
            restarted.save(B, ADDRESS, SECOND);
            restarted.clearIf(A, ADDRESS, SECOND);
            assertEquals(FIRST, restarted.load(A).intentId);
            restarted.clearIf(A, ADDRESS, FIRST);
            assertNull(restarted.load(A));
            assertEquals(SECOND, restarted.load(B).intentId);
        } finally {
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) Files.deleteIfExists(file.toPath());
            Files.deleteIfExists(directory.toPath());
        }
    }
}
