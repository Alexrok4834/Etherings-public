package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import android.content.Context;
import android.database.Cursor;

import androidx.room.Room;
import androidx.sqlite.db.SupportSQLiteDatabase;
import androidx.sqlite.db.SupportSQLiteOpenHelper;
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory;
import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.UUID;

import xyz.etherings.player.sync.EtheringsDatabase;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RafflePendingDrawStoreTest {
    private static final String OWNER_A = "11111111-1111-4111-8111-111111111111";
    private static final String OWNER_B = "22222222-2222-4222-8222-222222222222";
    private static final String CONFIGURATION = "33333333-3333-4333-8333-333333333333";
    private static final String KEY_A = "44444444-4444-4444-8444-444444444444";
    private static final String KEY_B = "55555555-5555-4555-8555-555555555555";

    private EtheringsDatabase database;
    private RafflePendingDrawStore store;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        database = Room.inMemoryDatabaseBuilder(context, EtheringsDatabase.class)
                .allowMainThreadQueries().build();
        store = new RafflePendingDrawStore(database);
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void keepsOnePendingOperationPerOwnerAndNeverLeaksAcrossOwners() {
        store.createSubmitting(OWNER_A, CONFIGURATION, KEY_A, 1000L);
        store.createSubmitting(OWNER_B, CONFIGURATION, KEY_B, 1000L);

        assertEquals(KEY_A, store.get(OWNER_A).idempotencyKey);
        assertEquals(KEY_B, store.get(OWNER_B).idempotencyKey);
        assertThrows(RuntimeException.class,
                () -> store.createSubmitting(OWNER_A, CONFIGURATION,
                        "66666666-6666-4666-8666-666666666666", 1001L));
        assertThrows(RuntimeException.class,
                () -> store.createSubmitting("77777777-7777-4777-8777-777777777777",
                        CONFIGURATION, KEY_A, 1001L));
    }

    @Test
    public void enforcesRecoveryCompletionRevealAndClearTransitions() {
        store.createSubmitting(OWNER_A, CONFIGURATION, KEY_A, 1000L);
        store.recoverInterruptedSubmission(OWNER_A, KEY_A, 1100L);
        assertEquals(RafflePendingDrawState.UNCERTAIN, store.get(OWNER_A).state);

        String snapshot = "{\"contractVersion\":\"raffle-v2\",\"operation\":{}}";
        store.storeCompleted(OWNER_A, KEY_A, snapshot, 1200L);
        RafflePendingDrawEntity completed = store.get(OWNER_A);
        assertEquals(RafflePendingDrawState.COMPLETED_UNREVEALED, completed.state);
        assertEquals(snapshot, completed.responseSnapshot);
        assertNull(completed.terminalErrorCode);

        assertThrows(IllegalStateException.class,
                () -> store.recoverInterruptedSubmission(OWNER_A, KEY_A, 1250L));
        store.markRevealed(OWNER_A, KEY_A, 1300L);
        store.clearTerminal(OWNER_A, KEY_A);
        assertNull(store.get(OWNER_A));
    }

    @Test
    public void artworkAcknowledgementReturnsCompletedResultDirectlyToReady() {
        store.createSubmitting(OWNER_A, CONFIGURATION, KEY_A, 1000L);
        store.storeCompleted(OWNER_A, KEY_A,
                "{\"contractVersion\":\"raffle-v2\",\"operation\":{}}", 1100L);

        store.acknowledgeCompleted(OWNER_A, KEY_A);

        assertNull(store.get(OWNER_A));
        assertThrows(IllegalStateException.class,
                () -> store.acknowledgeCompleted(OWNER_A, KEY_A));
    }

    @Test
    public void retainsTerminalNoChargeEvidenceUntilExplicitClear() {
        store.createSubmitting(OWNER_A, CONFIGURATION, KEY_A, 1000L);
        store.markTerminalRejected(OWNER_A, KEY_A, "RAFFLE_DAILY_LIMIT_REACHED", 1100L);

        RafflePendingDrawEntity rejected = store.get(OWNER_A);
        assertEquals(RafflePendingDrawState.TERMINAL_REJECTED, rejected.state);
        assertEquals("RAFFLE_DAILY_LIMIT_REACHED", rejected.terminalErrorCode);
        assertNull(rejected.responseSnapshot);
        store.clearTerminal(OWNER_A, KEY_A);
        assertNull(store.get(OWNER_A));
    }

    @Test
    public void persistsCompletedUnrevealedStateAcrossDatabaseReopen() {
        Context context = ApplicationProvider.getApplicationContext();
        String name = "raffle-pending-reopen-" + UUID.randomUUID() + ".db";
        EtheringsDatabase fileDatabase = Room.databaseBuilder(context, EtheringsDatabase.class, name)
                .allowMainThreadQueries().build();
        try {
            RafflePendingDrawStore fileStore = new RafflePendingDrawStore(fileDatabase);
            fileStore.createSubmitting(OWNER_A, CONFIGURATION, KEY_A, 1000L);
            fileStore.storeCompleted(OWNER_A, KEY_A,
                    "{\"contractVersion\":\"raffle-v2\",\"operation\":{}}", 1100L);
            fileDatabase.close();

            fileDatabase = Room.databaseBuilder(context, EtheringsDatabase.class, name)
                    .allowMainThreadQueries().build();
            RafflePendingDrawEntity recovered = new RafflePendingDrawStore(fileDatabase).get(OWNER_A);
            assertNotNull(recovered);
            assertEquals(RafflePendingDrawState.COMPLETED_UNREVEALED, recovered.state);
            assertEquals(KEY_A, recovered.idempotencyKey);

            new RafflePendingDrawStore(fileDatabase).markRevealed(OWNER_A, KEY_A, 1200L);
            fileDatabase.close();
            fileDatabase = Room.databaseBuilder(context, EtheringsDatabase.class, name)
                    .allowMainThreadQueries().build();
            RafflePendingDrawEntity acknowledged = new RafflePendingDrawStore(fileDatabase).get(OWNER_A);
            assertNotNull(acknowledged);
            assertEquals(RafflePendingDrawState.REVEALED, acknowledged.state);
            assertEquals(KEY_A, acknowledged.idempotencyKey);
        } finally {
            if (fileDatabase.isOpen()) fileDatabase.close();
            context.deleteDatabase(name);
        }
    }

    @Test
    public void migrationFromVersionTwoPreservesExistingRowsAndCreatesPendingTable() {
        Context context = ApplicationProvider.getApplicationContext();
        String name = "raffle-pending-migration-" + UUID.randomUUID() + ".db";
        SupportSQLiteOpenHelper helper = new FrameworkSQLiteOpenHelperFactory().create(
                SupportSQLiteOpenHelper.Configuration.builder(context).name(name)
                        .callback(new SupportSQLiteOpenHelper.Callback(2) {
                            @Override public void onCreate(SupportSQLiteDatabase db) {
                                db.execSQL("CREATE TABLE existing_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
                            }
                            @Override public void onUpgrade(SupportSQLiteDatabase db, int oldVersion, int newVersion) {}
                        }).build());
        SupportSQLiteDatabase sqlite = helper.getWritableDatabase();
        sqlite.execSQL("INSERT INTO existing_state(id,value) VALUES (1,'preserved')");
        EtheringsDatabase.MIGRATION_2_3.migrate(sqlite);

        try (Cursor existing = sqlite.query("SELECT value FROM existing_state WHERE id=1");
             Cursor pending = sqlite.query("PRAGMA table_info(raffle_pending_draw)")) {
            assertEquals(true, existing.moveToFirst());
            assertEquals("preserved", existing.getString(0));
            assertEquals(9, pending.getCount());
        } finally {
            helper.close();
            context.deleteDatabase(name);
        }
    }
}
