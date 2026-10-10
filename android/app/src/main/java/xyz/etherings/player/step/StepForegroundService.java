package xyz.etherings.player.step;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import java.security.GeneralSecurityException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.R;
import xyz.etherings.player.alpha.AlphaSessionStore;
import xyz.etherings.player.auth.SessionStore;
import xyz.etherings.player.sync.EtheringsDatabase;
import xyz.etherings.player.sync.RoomSyncStatusPublisher;
import xyz.etherings.player.sync.StepSyncScheduler;
import xyz.etherings.player.sync.SyncStatusStore;

public final class StepForegroundService extends Service implements SensorEventListener {
    public static final String ACTION_START = "xyz.etherings.player.step.START_FOREGROUND_TRACKING";
    public static final String ACTION_STOP = "xyz.etherings.player.step.STOP_FOREGROUND_TRACKING";

    private static final String CHANNEL_ID = "etherings_step_tracking";
    private static final int NOTIFICATION_ID = 2407;

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private StepDisplaySnapshotStore displaySnapshotStore;
    private volatile RoomStepCounterStore roomCounterStore;
    private volatile RoomSyncStatusPublisher syncStatusPublisher;
    private ExecutorService databaseExecutor;
    private Handler mainHandler;
    private volatile String ownerId;
    private volatile String alphaSessionLineage;
    private NotificationManager notificationManager;
    private boolean sensorRegistered;
    private volatile boolean initializationStarted;
    private volatile boolean destroyed;
    private int lastReadyBatchCount;

    public static Intent startIntent(Context context) {
        Intent intent = new Intent(context, StepForegroundService.class);
        intent.setAction(ACTION_START);
        return intent;
    }

    public static Intent stopIntent(Context context) {
        Intent intent = new Intent(context, StepForegroundService.class);
        intent.setAction(ACTION_STOP);
        return intent;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        displaySnapshotStore = new StepDisplaySnapshotStore(this);
        databaseExecutor = Executors.newSingleThreadExecutor();
        mainHandler = new Handler(Looper.getMainLooper());
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        stepCounterSensor = sensorManager == null ? null : sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
        displaySnapshotStore.startCapListening(() -> mainHandler.post(() -> {
            if (!destroyed && ownerId != null) {
                updateNotification(displaySnapshotStore.snapshot(ownerId),
                        stepCounterSensor != null);
            }
        }));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            unregisterStepSensor();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (BuildConfig.IS_ALPHA_DEV && new AlphaSessionStore(this).verified() == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        StepCounterSnapshot initialSnapshot = ownerId == null || BuildConfig.IS_ALPHA_DEV
                ? displaySnapshotStore.emptySnapshot()
                : displaySnapshotStore.snapshot(ownerId);
        startAsForeground(initialSnapshot, stepCounterSensor != null);
        if (ownerId != null) {
            unregisterStepSensor();
        }
        initializeRoomTracking();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        unregisterStepSensor();
        displaySnapshotStore.stopCapListening();
        destroyed = true;
        if (databaseExecutor != null) {
            databaseExecutor.shutdown();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null || event.sensor == null || event.sensor.getType() != Sensor.TYPE_STEP_COUNTER || event.values.length == 0) {
            return;
        }

        float rawCounterValue = event.values[0];
        long nowMs = StepSensorEventTime.observedAtMs(System.currentTimeMillis(),
                SystemClock.elapsedRealtimeNanos(), event.timestamp);
        String currentOwnerId = ownerId;
        String currentAlphaLineage = alphaSessionLineage;
        if (currentOwnerId == null || roomCounterStore == null || databaseExecutor == null) {
            return;
        }
        databaseExecutor.execute(() -> {
            try {
                if (BuildConfig.IS_ALPHA_DEV) {
                    AlphaSessionStore.VerifiedSession session = new AlphaSessionStore(this).verified();
                    if (session == null || currentAlphaLineage == null
                            || !currentOwnerId.equals(session.ownerId())
                            || !currentAlphaLineage.equals(session.lineage())) return;
                }
                StepCounterSnapshot snapshot = roomCounterStore.recordSensorCounter(
                        currentOwnerId,
                        rawCounterValue,
                        nowMs
                );
                displaySnapshotStore.save(currentOwnerId, snapshot);
                int readyBatchCount = roomCounterStore.readyBatchCount(currentOwnerId);
                if (readyBatchCount > lastReadyBatchCount) {
                    StepSyncScheduler.enqueueOneTime(this);
                }
                if (readyBatchCount != lastReadyBatchCount && syncStatusPublisher != null) {
                    syncStatusPublisher.publish(currentOwnerId);
                }
                lastReadyBatchCount = readyBatchCount;
                mainHandler.post(() -> {
                    if (!destroyed) {
                        updateNotification(snapshot, true);
                    }
                });
            } catch (RuntimeException error) {
                mainHandler.post(() -> handleTrackingFailure("Step storage unavailable"));
            }
        });
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    private void registerStepSensor() {
        if (sensorRegistered || sensorManager == null || stepCounterSensor == null) {
            return;
        }

        sensorRegistered = sensorManager.registerListener(this, stepCounterSensor, SensorManager.SENSOR_DELAY_NORMAL);
        if (!sensorRegistered) {
            updateNotification(displaySnapshotStore.emptySnapshot(), false);
        }
    }

    private void unregisterStepSensor() {
        if (!sensorRegistered || sensorManager == null) {
            return;
        }

        sensorManager.unregisterListener(this);
        sensorRegistered = false;
    }

    private void startAsForeground(StepCounterSnapshot snapshot, boolean sensorAvailable) {
        Notification notification = buildNotification(snapshot, sensorAvailable);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH);
            return;
        }

        startForeground(NOTIFICATION_ID, notification);
    }

    private void updateNotification(StepCounterSnapshot snapshot, boolean sensorAvailable) {
        if (notificationManager != null) {
            notificationManager.notify(NOTIFICATION_ID, buildNotification(snapshot, sensorAvailable));
        }
    }

    private Notification buildNotification(StepCounterSnapshot snapshot, boolean sensorAvailable) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        String text = StepNotificationPresentation.content(
                sensorAvailable,
                snapshot.dailySteps(),
                displaySnapshotStore.serverDailyStepCap(ownerId)
        );

        return builder
                .setSmallIcon(R.drawable.ic_step_notification)
                .setContentTitle(StepNotificationPresentation.title())
                .setContentText(text)
                .setOngoing(true)
                .setShowWhen(false)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "EtheRings step tracking",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("EtheRings tracks steps automatically in the background");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void initializeRoomTracking() {
        if (initializationStarted || databaseExecutor == null) {
            return;
        }
        initializationStarted = true;
        databaseExecutor.execute(() -> {
            try {
                AlphaSessionStore.VerifiedSession alphaSession = BuildConfig.IS_ALPHA_DEV
                        ? new AlphaSessionStore(this).verified() : null;
                String restoredOwnerId = BuildConfig.IS_ALPHA_DEV
                        ? alphaSession == null ? null : alphaSession.ownerId()
                        : new SessionStore(this).getOwnerId();
                if (restoredOwnerId == null) {
                    throw new IllegalStateException("Owner identity is unavailable");
                }
                EtheringsDatabase database = EtheringsDatabase.open(this);
                StepRoomBootstrapper.bootstrap(this, database, System.currentTimeMillis());
                RoomStepCounterStore store = new RoomStepCounterStore(database);
                RoomSyncStatusPublisher statusPublisher = new RoomSyncStatusPublisher(
                        database,
                        new SyncStatusStore(this)
                );
                StepCounterSnapshot snapshot = store.snapshotAndCloseAgedBatch(
                        restoredOwnerId,
                        System.currentTimeMillis()
                );
                if (BuildConfig.IS_ALPHA_DEV) {
                    AlphaSessionStore.VerifiedSession current = new AlphaSessionStore(this).verified();
                    if (current == null || !restoredOwnerId.equals(current.ownerId())
                            || !alphaSession.lineage().equals(current.lineage())) {
                        throw new IllegalStateException("Alpha session changed during step recovery");
                    }
                }
                displaySnapshotStore.save(restoredOwnerId, snapshot);
                lastReadyBatchCount = store.readyBatchCount(restoredOwnerId);
                statusPublisher.publish(restoredOwnerId);
                if (lastReadyBatchCount > 0) {
                    StepSyncScheduler.enqueueOneTime(this);
                }
                ownerId = restoredOwnerId;
                alphaSessionLineage = alphaSession == null ? null : alphaSession.lineage();
                roomCounterStore = store;
                syncStatusPublisher = statusPublisher;
                mainHandler.post(() -> {
                    if (!destroyed) {
                        initializationStarted = false;
                        updateNotification(snapshot, stepCounterSensor != null);
                        registerStepSensor();
                    }
                });
            } catch (GeneralSecurityException | RuntimeException error) {
                initializationStarted = false;
                mainHandler.post(() -> handleTrackingFailure("Sign in to resume step tracking"));
            }
        });
    }

    private void handleTrackingFailure(String message) {
        if (destroyed) {
            return;
        }
        unregisterStepSensor();
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        if (notificationManager != null) {
            notificationManager.notify(
                    NOTIFICATION_ID,
                    builder.setSmallIcon(R.drawable.ic_step_notification)
                            .setContentTitle(StepNotificationPresentation.title())
                            .setContentText(message)
                            .setOngoing(true)
                            .setShowWhen(false)
                            .build()
            );
        }
    }
}
