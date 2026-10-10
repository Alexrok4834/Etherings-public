package xyz.etherings.player;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.DialogInterface;
import android.graphics.Rect;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.TypedValue;
import android.view.View;
import android.view.Gravity;
import android.view.TouchDelegate;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.EditText;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.text.DateFormat;
import java.security.GeneralSecurityException;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import xyz.etherings.player.api.ApiClient;
import xyz.etherings.player.api.ApiConfig;
import xyz.etherings.player.api.EtheringsApi;
import xyz.etherings.player.alpha.AlphaLaunchGate;
import xyz.etherings.player.alpha.AlphaSessionStore;
import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.auth.LoginSessionService;
import xyz.etherings.player.auth.LoginUiState;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.RoomInstallationIdProvider;
import xyz.etherings.player.auth.SessionCredentials;
import xyz.etherings.player.auth.SessionStore;
import xyz.etherings.player.home.HomeProfile;
import xyz.etherings.player.home.HomeProfileStore;
import xyz.etherings.player.home.PassiveProfileRefreshGate;
import xyz.etherings.player.home.HomeRepository;
import xyz.etherings.player.home.AlphaStepReceiptPresentation;
import xyz.etherings.player.home.AlphaHomeEconomySnapshot;
import xyz.etherings.player.home.WalkStatusPresentation;
import xyz.etherings.player.profile.ProfileManagementService;
import xyz.etherings.player.profile.ActivityHistoryRepository;
import xyz.etherings.player.profile.DailyActivityItem;
import xyz.etherings.player.ui.SmallScreenLayout;
import xyz.etherings.player.ui.HalfHeightActionSlot;
import xyz.etherings.player.update.AppRelease;
import xyz.etherings.player.update.AppReleaseClient;
import xyz.etherings.player.update.AppUpdateStore;
import xyz.etherings.player.update.AppUpdateNotice;
import xyz.etherings.player.raffle.RafflePendingDrawEntity;
import xyz.etherings.player.raffle.RafflePendingDrawState;
import xyz.etherings.player.raffle.RafflePendingDrawStore;
import xyz.etherings.player.raffle.RaffleAffordability;
import xyz.etherings.player.raffle.RaffleRewardArtwork;
import xyz.etherings.player.raffle.RaffleV2Draw;
import xyz.etherings.player.raffle.RaffleV2DrawCoordinator;
import xyz.etherings.player.raffle.RaffleV2HistoryPage;
import xyz.etherings.player.raffle.RaffleV2ReadRepository;
import xyz.etherings.player.raffle.RaffleV2SelectionEvidence;
import xyz.etherings.player.raffle.RaffleV2UiState;
import xyz.etherings.player.raffle.RaffleWheelModel;
import xyz.etherings.player.raffle.RaffleWheelView;
import xyz.etherings.player.ring.CopperRing;
import xyz.etherings.player.ring.CopperRingCache;
import xyz.etherings.player.ring.CopperRingRepository;
import xyz.etherings.player.ring.CopperRingUiState;
import xyz.etherings.player.ring.CopperRingUiText;
import xyz.etherings.player.ring.CopperRingVisualCatalog;
import xyz.etherings.player.ring.SilverInventorySnapshot;
import xyz.etherings.player.ring.AlphaStarterSnapshot;
import xyz.etherings.player.ring.AlphaRingEquipmentSnapshot;
import xyz.etherings.player.ring.SilverOpeningReadiness;
import xyz.etherings.player.ring.EquippedCopperRing;
import xyz.etherings.player.ring.CopperAttributeAllocation;
import xyz.etherings.player.ring.CopperAttributeAllocationResult;
import xyz.etherings.player.ring.CopperAttributeDraft;
import xyz.etherings.player.ring.CopperLevelPreview;
import xyz.etherings.player.ring.CopperLevelUpResult;
import xyz.etherings.player.ring.CopperMutationRetryKey;
import xyz.etherings.player.step.StepCounterSnapshot;
import xyz.etherings.player.step.StepDisplaySnapshotStore;
import xyz.etherings.player.step.StepSensorCapability;
import xyz.etherings.player.step.StepTrackingState;
import xyz.etherings.player.step.StepTrackingRecovery;
import xyz.etherings.player.step.RoomLegacyWindowRecovery;
import xyz.etherings.player.sync.StepSyncScheduler;
import xyz.etherings.player.sync.EtheringsDatabase;
import xyz.etherings.player.sync.RoomSyncStatusPublisher;
import xyz.etherings.player.sync.SyncStatusSnapshot;
import xyz.etherings.player.sync.SyncStatusStore;

public class MainActivity extends Activity {
    public static final String ALPHA_VERIFIED_EMAIL = "xyz.etherings.player.alpha.VERIFIED_EMAIL";
    public static final String ALPHA_LOGOUT = "xyz.etherings.player.alpha.LOGOUT";
    public static final String ALPHA_REVEAL_PHRASE = "xyz.etherings.player.alpha.REVEAL_PHRASE";
    public static final String ALPHA_CHANGE_PASSWORD = "xyz.etherings.player.alpha.CHANGE_PASSWORD";
    private enum Mode {
        WALK,
        DRAW,
        PROFILE,
        RINGS,
        MARKETPLACE,
        ACTIVITY,
        WALLET
    }

    private enum ProfileActivitySection {
        ACTIVITY,
        DRAW_HISTORY
    }

    private static final class ProfileActivityDialogState {
        private final TextView activityTab;
        private final TextView drawHistoryTab;
        private final TextView status;
        private final LinearLayout list;
        private final TextView retry;
        private AlertDialog dialog;
        private ProfileActivitySection selected = ProfileActivitySection.ACTIVITY;
        private int requestGeneration;

        private ProfileActivityDialogState(TextView activityTab, TextView drawHistoryTab,
                TextView status, LinearLayout list, TextView retry) {
            this.activityTab = activityTab;
            this.drawHistoryTab = drawHistoryTab;
            this.status = status;
            this.list = list;
            this.retry = retry;
        }
    }

    private static final int STEP_PERMISSION_REQUEST_CODE = 2408;
    private static final long STALE_PROFILE_RETRY_DELAY_MS = 15_000L;

    private int accentColor;
    private int outlineColor;
    private int textColor;
    private int mutedColor;
    private int backgroundColor;
    private int panelColor;
    private int elevatedPanelColor;
    private int onAccentColor;
    private int disabledFillColor;
    private int disabledTextColor;
    private int errorColor;

    private HomeRepository homeRepository;
    private LoginSessionService loginSessionService;
    private ProfileManagementService profileManagementService;
    private ActivityHistoryRepository activityHistoryRepository;
    private RaffleV2ReadRepository raffleV2ReadRepository;
    private RaffleV2DrawCoordinator raffleV2DrawCoordinator;
    private RafflePendingDrawStore rafflePendingDrawStore;
    private CopperRingRepository copperRingRepository;
    private StepSensorCapability stepSensorCapability;
    private StepDisplaySnapshotStore stepDisplaySnapshotStore;
    private SessionStore sessionStore;
    private SyncStatusStore syncStatusStore;
    private StepCounterSnapshot stepCounterSnapshot;
    private StepTrackingState stepTrackingState;
    private HomeProfile currentProfile;
    private boolean currentProfileStale;
    private boolean currentServerValuesKnown;
    private final PassiveProfileRefreshGate passiveProfileRefreshGate = new PassiveProfileRefreshGate();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService alphaSilverIo = Executors.newSingleThreadExecutor();
    private final ExecutorService alphaScreenIo = Executors.newFixedThreadPool(3);
    // A new screen must not wait behind Home's two independent reads.
    private final ExecutorService alphaAssetReadIo = Executors.newFixedThreadPool(5);
    private final ExecutorService alphaSilverMediaIo = Executors.newSingleThreadExecutor();
    private final ExecutorService alphaEconomyIo = Executors.newSingleThreadExecutor();
    private AlphaHomeEconomySnapshot alphaEconomy;
    private int alphaEconomyGeneration;
    private int alphaActivityGeneration;
    private boolean alphaActivityLoading;
    private long alphaActivityDeliveryAt;
    private boolean alphaEconomyLoading;
    private boolean alphaEconomyRefreshPending;
    private long alphaEconomyDeliveryAt;
    private int alphaSilverGeneration;
    private int alphaStarterPendingPolls;
    private SilverInventorySnapshot alphaSilverInventory;
    private AlphaStarterSnapshot alphaStarterInventory;
    private List<CopperRing> alphaHomeCoopers;
    private Map<String, Bitmap> alphaCooperArtwork = Collections.emptyMap();
    private AlphaRingEquipmentSnapshot alphaRingEquipment;
    private boolean alphaCooperDetail;
    private String alphaCooperDetailId;
    private boolean alphaOpenEquippedDetailOnLoad;
    private boolean alphaEquipInFlight;
    private boolean alphaCooperProgressInFlight;
    private boolean alphaSilverProgressInFlight;
    private String alphaSilverDraftMint;
    private String alphaSilverDraftState;
    private final int[] alphaSilverDraft = new int[4];
    private final CopperMutationRetryKey pendingAlphaSilverLevelUp = new CopperMutationRetryKey();
    private final CopperMutationRetryKey pendingAlphaLevelUp = new CopperMutationRetryKey();
    private final CopperMutationRetryKey pendingAlphaBreeding = new CopperMutationRetryKey();
    private final CopperMutationRetryKey pendingAlphaMarketplace = new CopperMutationRetryKey();
    private boolean alphaMarketplaceInFlight;
    private int alphaMarketplaceGeneration;
    private boolean alphaMarketplaceMyListings;
    private ScrollView alphaMarketplaceScrollView;
    private LinearLayout alphaMarketplaceListView;
    private TextView alphaMarketplaceBrowseTab;
    private TextView alphaMarketplaceMineTab;
    private final CopperMutationRetryKey pendingAlphaAllocation = new CopperMutationRetryKey();
    private boolean alphaActivityStarted;
    private final CopperMutationRetryKey pendingAlphaEquipment = new CopperMutationRetryKey();
    private String alphaSilverDetailMint;
    private final Runnable staleProfileRetry = this::refreshStaleProfileSilently;
    private boolean silentProfileRefreshInFlight;
    private boolean activityStarted;
    private boolean stepPermissionRequestInFlight;
    private boolean raffleCurrentLoading;
    private boolean raffleCurrentLoaded;
    private boolean raffleDrawInFlight;
    private RaffleV2Draw currentRaffleDraw;
    private int raffleRequestGeneration;
    private Mode selectedMode = Mode.WALK;
    private ImageView avatarView;
    private LinearLayout headerBalancesView;
    private ImageView headerErtIconView;
    private TextView headerErtValueView;
    private ImageView headerEruIconView;
    private TextView headerEruValueView;
    private LinearLayout stepStatusBlockView;
    private TextView stepProgressView;
    private ImageView copperRingArtworkView;
    private ScrollView copperRingInventoryView;
    private LinearLayout copperRingInventoryListView;
    private LinearLayout copperRingDetailMetricsView;
    private ScrollView copperRingDetailScrollView;
    private TextView copperRingStatusView;
    private TextView copperRingRetryView;
    private TextView stepStatusView;
    private LinearLayout modeContentPanelView;
    private LinearLayout homeShellView;
    private TextView panelTitleView;
    private TextView panelBodyView;
    private EditText usernameInput;
    private EditText passwordInput;
    private EditText registrationDisplayNameInput;
    private EditText registrationPasswordConfirmationInput;
    private TextView loginButton;
    private TextView authModeButton;
    private TextView loginMessageView;
    private boolean registrationMode;
    private TextView balanceView;
    private TextView stepsView;
    private TextView acceptedStepsView;
    private TextView earnedView;
    private TextView raffleView;
    private TextView trackingView;
    private TextView syncStatusView;
    private ScrollView rafflePoolsScrollView;
    private LinearLayout rafflePoolsContainer;
    private TextView raffleDrawResultView;
    private RaffleWheelView raffleWheelView;
    private TextView raffleAttemptsView;
    private TextView raffleV2ActionView;
    private AlertDialog raffleRewardDialog;
    private String raffleRewardDialogKey;
    private AlertDialog appUpdateDialog;
    private AppUpdateStore appUpdateStore;
    private AppUpdateNotice alphaUpdateNotice;
    private TextView retryView;
    private TextView changeNameView;
    private TextView activityHistoryView;
    private TextView drawHistoryView;
    private TextView changePasswordView;
    private TextView recoveryPhraseView;
    private TextView signOutView;
    private TextView profileVersionView;
    private LinearLayout modeTabsView;
    private TextView homeTab;
    private TextView drawTab;
    private TextView ringsTab;
    private TextView marketplaceTab;
    private Map<String, Bitmap> alphaSilverArtwork = Collections.emptyMap();
    private Map<String, Bitmap> alphaMarketplaceArtwork = Collections.emptyMap();
    private boolean alphaHomeRefreshing;
    private boolean alphaInventoryRefreshing;
    private boolean alphaMarketplaceRefreshing;
    private List<JSONObject> alphaMarketplaceLastListings;
    private List<SilverInventorySnapshot.Asset> alphaMarketplaceLastAssets;
    private String alphaMarketplaceLastWallet;
    private String alphaMarketplaceLastEmail;
    private boolean alphaMarketplaceLastMine;
    private String alphaSnapshotOwnerId;
    private CopperRingUiState copperRingUiState;
    private String copperRingOwnerId;
    private String copperRingDetailId;
    private Mode copperRingDetailReturnMode = Mode.WALK;
    private int copperRingRequestGeneration;
    private boolean copperLevelUpInFlight;
    private boolean copperAllocationInFlight;
    private boolean copperEquipmentInFlight;
    private final CopperMutationRetryKey pendingLevelUp = new CopperMutationRetryKey();
    private final CopperMutationRetryKey pendingAllocation = new CopperMutationRetryKey();
    private final CopperMutationRetryKey pendingEquipment = new CopperMutationRetryKey();
    private String copperAttributeDraftRingId;
    private CopperAttributeDraft copperAttributeDraft;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (BuildConfig.IS_ALPHA_DEV) {
            String verifiedEmail = getIntent().getStringExtra(ALPHA_VERIFIED_EMAIL);
            if (savedInstanceState != null || !AlphaLaunchGate.consume(verifiedEmail)) {
                startActivity(new Intent().setClassName(this,
                        "xyz.etherings.player.alpha.AlphaAuthActivity"));
                finish();
                return;
            }
            loadVisualTokens();
            stepSensorCapability = StepSensorCapability.detect(this);
            stepDisplaySnapshotStore = new StepDisplaySnapshotStore(this);
            syncStatusStore = new SyncStatusStore(this);
            refreshStepTrackingState();
            setContentView(buildHomeShell());
            ensureStepTrackingAfterAuth();
            StepSyncScheduler.scheduleAll(this);
            AlphaSessionStore.VerifiedSession initialSession = new AlphaSessionStore(this).verified();
            alphaSnapshotOwnerId = initialSession == null ? null : initialSession.ownerId();
            renderAlphaMode();
            if ("alphaRelease".equals(BuildConfig.BUILD_TYPE)) {
                alphaUpdateNotice = new AppUpdateNotice(this);
            }
            return;
        }
        loadVisualTokens();
        stepSensorCapability = StepSensorCapability.detect(this);
        stepDisplaySnapshotStore = new StepDisplaySnapshotStore(this);
        refreshStepTrackingState();
        ApiConfig apiConfig = ApiConfig.fromBuildConfig();
        EtheringsApi api = new EtheringsApi(new ApiClient(apiConfig), apiConfig);
        sessionStore = new SessionStore(this);
        syncStatusStore = new SyncStatusStore(this);
        AuthenticatedSession authenticatedSession = new AuthenticatedSession(api, sessionStore);
        HomeProfileStore homeProfileStore = new HomeProfileStore(this);
        homeRepository = new HomeRepository(
                api,
                authenticatedSession,
                sessionStore,
                homeProfileStore
        );
        profileManagementService = new ProfileManagementService(api, authenticatedSession, homeProfileStore);
        activityHistoryRepository = new ActivityHistoryRepository(api, authenticatedSession);
        loginSessionService = new LoginSessionService(
                api,
                sessionStore,
                new RoomInstallationIdProvider(this),
                authenticatedSession,
                new RoomLegacyWindowRecovery(this, sessionStore)
        );
        raffleV2ReadRepository = new RaffleV2ReadRepository(api, authenticatedSession);
        rafflePendingDrawStore = new RafflePendingDrawStore(EtheringsDatabase.open(this));
        raffleV2DrawCoordinator = new RaffleV2DrawCoordinator(
                api, authenticatedSession, sessionStore, rafflePendingDrawStore
        );
        copperRingRepository = new CopperRingRepository(
                api,
                authenticatedSession,
                sessionStore,
                new CopperRingCache(this)
        );
        appUpdateStore = new AppUpdateStore(this);
        setContentView(buildHomeShell());
        StepTrackingRecovery.startIfEligible(this);
        StepSyncScheduler.scheduleAll(this);
        loadHomeProfile();
        checkForAppUpdate();
    }

    private void loadVisualTokens() {
        accentColor = getColor(R.color.brand_accent);
        outlineColor = getColor(R.color.brand_outline);
        textColor = getColor(R.color.brand_text_primary);
        mutedColor = getColor(R.color.brand_text_secondary);
        backgroundColor = getColor(R.color.brand_background);
        panelColor = getColor(R.color.brand_surface);
        elevatedPanelColor = getColor(R.color.brand_surface_elevated);
        onAccentColor = getColor(R.color.brand_on_accent);
        disabledFillColor = getColor(R.color.brand_disabled_surface);
        disabledTextColor = getColor(R.color.brand_disabled_text);
        errorColor = getColor(R.color.brand_error);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (BuildConfig.IS_ALPHA_DEV) {
            if (alphaUpdateNotice != null) alphaUpdateNotice.onStart();
            if (stepDisplaySnapshotStore == null || syncStatusStore == null) return;
            AlphaSessionStore.VerifiedSession session = new AlphaSessionStore(this).verified();
            String ownerId = session == null ? null : session.ownerId();
            if (ownerId == null || !ownerId.equals(alphaSnapshotOwnerId))
                clearAlphaVisualSnapshots();
            alphaSnapshotOwnerId = ownerId;
            stepDisplaySnapshotStore.startListening(() -> runOnUiThread(this::renderAlphaStepReceipts));
            syncStatusStore.startListening(() -> runOnUiThread(this::renderAlphaStepReceipts));
            if (alphaActivityStarted) renderAlphaMode();
            renderAlphaStepReceipts();
            alphaActivityStarted = true;
            loadAlphaEconomy();
            return;
        }
        activityStarted = true;
        stepDisplaySnapshotStore.startListening(() -> runOnUiThread(this::renderLiveStepSnapshot));
        syncStatusStore.startListening(() -> runOnUiThread(this::renderLiveSyncStatus));
        renderLiveStepSnapshot();
        renderLiveSyncStatus();
        refreshSyncStatusAsync();
        scheduleStaleProfileRetry();
    }

    @Override
    protected void onStop() {
        if (BuildConfig.IS_ALPHA_DEV) {
            if (alphaUpdateNotice != null) alphaUpdateNotice.onStop();
            if (stepDisplaySnapshotStore != null) stepDisplaySnapshotStore.stopListening();
            if (syncStatusStore != null) syncStatusStore.stopListening();
            alphaSilverGeneration++;
            pendingAlphaEquipment.clear();
            if (copperRingArtworkView != null) copperRingArtworkView.setVisibility(View.GONE);
            super.onStop();
            return;
        }
        activityStarted = false;
        stepDisplaySnapshotStore.stopListening();
        syncStatusStore.stopListening();
        mainHandler.removeCallbacks(staleProfileRetry);
        super.onStop();
    }

    private void clearAlphaVisualSnapshots() {
        alphaRingEquipment = null;
        alphaStarterInventory = null;
        alphaHomeCoopers = null;
        alphaCooperArtwork = Collections.emptyMap();
        alphaSilverInventory = null;
        alphaSilverArtwork = Collections.emptyMap();
        alphaMarketplaceArtwork = Collections.emptyMap();
        alphaMarketplaceLastListings = null;
        alphaMarketplaceLastAssets = null;
        alphaMarketplaceLastWallet = null;
        alphaMarketplaceLastEmail = null;
    }

    @Override
    protected void onDestroy() {
        alphaSilverGeneration++;
        alphaSilverIo.shutdownNow();
        alphaScreenIo.shutdownNow();
        alphaAssetReadIo.shutdownNow();
        alphaSilverMediaIo.shutdownNow();
        alphaEconomyGeneration++;
        alphaActivityGeneration++;
        alphaEconomyIo.shutdownNow();
        if (raffleRewardDialog != null) raffleRewardDialog.dismiss();
        if (appUpdateDialog != null) appUpdateDialog.dismiss();
        super.onDestroy();
    }

    private void checkForAppUpdate() {
        long nowMs = System.currentTimeMillis();
        AppRelease cached = appUpdateStore.freshCachedRelease(nowMs);
        if (cached != null) {
            showAppUpdateIfAvailable(cached, nowMs);
            return;
        }
        if (!appUpdateStore.shouldCheckNetwork(nowMs)) return;

        new Thread(() -> {
            try {
                AppRelease release = new AppReleaseClient().fetch();
                long completedAtMs = System.currentTimeMillis();
                appUpdateStore.recordSuccess(release, completedAtMs);
                runOnUiThread(() -> showAppUpdateIfAvailable(release, completedAtMs));
            } catch (IOException | JSONException error) {
                appUpdateStore.recordFailure(System.currentTimeMillis());
            }
        }).start();
    }

    private void showAppUpdateIfAvailable(AppRelease release, long nowMs) {
        if (isFinishing() || isDestroyed()
                || appUpdateDialog != null
                || !appUpdateStore.shouldPrompt(release, BuildConfig.VERSION_CODE, nowMs)) {
            return;
        }

        double sizeMiB = release.sizeBytes() / (1024d * 1024d);
        String message = "EtheRings " + release.displayVersion() + " is available ("
                + String.format(Locale.US, "%.1f", sizeMiB) + " MiB)."
                + (release.required() ? " This update is marked as required." : "");
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(release.required() ? "Update required" : "Update available")
                .setMessage(message)
                .setNegativeButton("Later", (ignored, which) ->
                        appUpdateStore.recordDismissed(release, System.currentTimeMillis()))
                .setPositiveButton("Download", (ignored, which) -> openAppDownload(release))
                .create();
        dialog.setOnCancelListener(ignored ->
                appUpdateStore.recordDismissed(release, System.currentTimeMillis()));
        dialog.setOnDismissListener(ignored -> appUpdateDialog = null);
        appUpdateDialog = dialog;
        dialog.show();
    }

    private void openAppDownload(AppRelease release) {
        Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(release.downloadUrl()));
        try {
            startActivity(browser);
        } catch (ActivityNotFoundException error) {
            new AlertDialog.Builder(this)
                    .setTitle("Download unavailable")
                    .setMessage("No browser is available to open the update download.")
                    .setPositiveButton("OK", null)
                    .show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != STEP_PERMISSION_REQUEST_CODE) {
            return;
        }

        stepPermissionRequestInFlight = false;
        refreshStepTrackingState();
        if (missingStepPermissions().isEmpty()) {
            StepTrackingRecovery.startIfEligible(this);
        }
        if (BuildConfig.IS_ALPHA_DEV) renderAlphaMode();
        else renderSelectedMode();
    }

    private void ensureStepTrackingAfterAuth() {
        refreshStepTrackingState();
        if (!stepSensorCapability.isStepCounterSupported()) {
            return;
        }

        List<String> missingPermissions = missingStepPermissions();
        if (missingPermissions.isEmpty()) {
            StepTrackingRecovery.startIfEligible(this);
            return;
        }

        if (!stepPermissionRequestInFlight) {
            stepPermissionRequestInFlight = true;
            requestPermissions(missingPermissions.toArray(new String[0]), STEP_PERMISSION_REQUEST_CODE);
        }
    }

    private void refreshStepTrackingState() {
        boolean activityPermissionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                || checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
        boolean notificationPermissionMissing = Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED;
        stepCounterSnapshot = currentProfile == null
                ? stepDisplaySnapshotStore.emptySnapshot()
                : stepDisplaySnapshotStore.snapshot(currentProfile.userId());
        stepTrackingState = StepTrackingState.from(
                stepSensorCapability,
                activityPermissionGranted,
                stepCounterSnapshot.eventCount(),
                stepCounterSnapshot.lastSensorUpdateAtMs(),
                System.currentTimeMillis(),
                notificationPermissionMissing
        );
    }

    @SuppressLint("SetTextI18n")
    private void renderLiveStepSnapshot() {
        if (currentProfile == null || trackingView == null || stepStatusView == null) {
            return;
        }
        refreshStepTrackingState();
        renderStepProgress();
        renderWalkStatus();
        stepStatusView.setText(trackingStatusMessage());
    }

    private void renderStepProgress() {
        long stepsToday = stepCounterSnapshot == null ? 0L : stepCounterSnapshot.dailySteps();
        Integer serverCap = currentProfile == null ? null : currentProfile.dailyStepCap();
        stepProgressView.setText(stepsToday + " / " + (serverCap == null ? "--" : serverCap) + " steps");
    }

    private void refreshSyncStatusAsync() {
        if (currentProfile == null) {
            return;
        }
        String ownerId = currentProfile.userId();
        new Thread(() -> {
            try {
                SessionCredentials credentials = sessionStore.getCredentials();
                if (credentials == null || !ownerId.equals(credentials.ownerId())) {
                    return;
                }
                new RoomSyncStatusPublisher(EtheringsDatabase.open(this), syncStatusStore).publish(ownerId);
            } catch (GeneralSecurityException | RuntimeException ignored) {
                // The persisted snapshot remains available while Room or Keystore is temporarily unavailable.
            }
        }).start();
    }

    @SuppressLint("SetTextI18n")
    private void renderLiveSyncStatus() {
        if (currentProfile == null || syncStatusView == null) {
            return;
        }
        SyncStatusSnapshot snapshot = syncStatusStore.snapshot(currentProfile.userId());
        renderWalkStatus(snapshot);
        refreshProfileAfterSuccessfulDelivery(snapshot);
    }

    private void refreshProfileAfterSuccessfulDelivery(SyncStatusSnapshot snapshot) {
        if (!passiveProfileRefreshGate.beginIfAdvanced(snapshot.lastSuccessfulSyncAtMs())) {
            return;
        }

        refreshHomeProfileSilently(passiveProfileRefreshGate::finish);
    }

    private void refreshStaleProfileSilently() {
        if (currentProfile == null || !currentProfileStale) {
            return;
        }
        refreshHomeProfileSilently(null);
    }

    private void refreshHomeProfileSilently(Runnable completion) {
        if (silentProfileRefreshInFlight) {
            if (completion != null) {
                completion.run();
            }
            return;
        }
        silentProfileRefreshInFlight = true;
        new Thread(() -> {
            HomeRepository.Result result = homeRepository.loadHomeProfile();
            runOnUiThread(() -> {
                silentProfileRefreshInFlight = false;
                if (completion != null) {
                    completion.run();
                }
                renderHomeResult(result);
            });
        }).start();
    }

    private void scheduleStaleProfileRetry() {
        mainHandler.removeCallbacks(staleProfileRetry);
        if (activityStarted && currentProfile != null && currentProfileStale) {
            mainHandler.postDelayed(staleProfileRetry, STALE_PROFILE_RETRY_DELAY_MS);
        }
    }

    private void renderWalkStatus() {
        if (currentProfile == null) {
            return;
        }
        renderWalkStatus(syncStatusStore.snapshot(currentProfile.userId()));
    }

    private void renderWalkStatus(SyncStatusSnapshot snapshot) {
        String lastSuccess = snapshot.lastSuccessfulSyncAtMs() <= 0L
                ? "never"
                : DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                        .format(new Date(snapshot.lastSuccessfulSyncAtMs()));
        WalkStatusPresentation status = WalkStatusPresentation.from(
                stepCounterSnapshot.dailySteps(),
                stepCounterSnapshot.rewardWindowSteps(),
                currentProfile.acceptedStepsToday(),
                currentProfile.earnedErtTodayDisplay(),
                snapshot,
                lastSuccess
        );
        stepsView.setText(status.localSteps());
        trackingView.setText(status.rewardWindow());
        acceptedStepsView.setText(status.acceptedSteps());
        earnedView.setText(status.earnedErt());
        syncStatusView.setText(status.deliveryStatus());
    }

    private List<String> missingStepPermissions() {
        List<String> permissions = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.ACTIVITY_RECOGNITION);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        return permissions;
    }

    private LinearLayout buildHomeShell() {
        LinearLayout root = new LinearLayout(this);
        homeShellView = root;
        root.setId(R.id.app_shell);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(backgroundColor);
        int screenInset = dimensionPixelSize(R.dimen.space_lg);
        root.setPadding(
                screenInset,
                dimensionPixelSize(R.dimen.space_md),
                screenInset,
                dimensionPixelSize(R.dimen.space_md)
        );
        root.setLayoutParams(matchParent());

        if (BuildConfig.IS_ALPHA_DEV) applyAlphaShellInsets(root, screenInset);

        root.addView(brandHeader());
        root.addView(stepStatusBlock());
        root.addView(modeContentPanel());
        root.addView(modeTabs());
        return root;
    }

    private void applyAlphaShellInsets(LinearLayout root, int horizontalInset) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            View decor = getWindow().getDecorView();
            decor.setSystemUiVisibility(decor.getSystemUiVisibility()
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        int top = dimensionPixelSize(R.dimen.space_md);
        int bottom = dimensionPixelSize(R.dimen.space_md);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left;
            int insetTop;
            int right;
            int insetBottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout());
                left = bars.left;
                insetTop = bars.top;
                right = bars.right;
                insetBottom = bars.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                insetTop = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                insetBottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(horizontalInset + left, top + insetTop,
                    horizontalInset + right, bottom + insetBottom);
            return insets;
        });
    }

    private LinearLayout brandHeader() {
        LinearLayout row = new LinearLayout(this);
        row.setId(R.id.brand_header);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout profileSlot = new LinearLayout(this);
        profileSlot.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        profileSlot.setLayoutParams(new LinearLayout.LayoutParams(
                BuildConfig.IS_ALPHA_DEV ? ViewGroup.LayoutParams.WRAP_CONTENT : 0,
                ViewGroup.LayoutParams.MATCH_PARENT,
                BuildConfig.IS_ALPHA_DEV ? 0f : 1f
        ));

        avatarView = new ImageView(this);
        avatarView.setId(R.id.profile_entry);
        avatarView.setImageResource(android.R.drawable.ic_menu_myplaces);
        avatarView.setColorFilter(accentColor);
        avatarView.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        avatarView.setPadding(
                dimensionPixelSize(R.dimen.space_md),
                dimensionPixelSize(R.dimen.space_md),
                dimensionPixelSize(R.dimen.space_md),
                dimensionPixelSize(R.dimen.space_md)
        );
        avatarView.setContentDescription(getString(R.string.profile_entry_content_description));
        avatarView.setBackground(new BorderDrawable(
                outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_profile_entry),
                panelColor
        ));
        int avatarSize = dimensionPixelSize(R.dimen.profile_entry_size);
        avatarView.setLayoutParams(new LinearLayout.LayoutParams(avatarSize, avatarSize));
        avatarView.setOnClickListener(view -> {
            if (BuildConfig.IS_ALPHA_DEV) {
                selectMode(Mode.PROFILE);
                return;
            }
            if (currentProfile == null) {
                showLoginForm(null);
                return;
            }
            selectMode(Mode.PROFILE);
        });
        profileSlot.addView(avatarView);
        row.addView(profileSlot);

        ImageView logoView = new ImageView(this);
        logoView.setId(R.id.brand_logo);
        logoView.setImageResource(R.drawable.etherings_logo_gold);
        logoView.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        logoView.setContentDescription(getString(R.string.brand_logo_content_description));
        int logoSize = dimensionPixelSize(R.dimen.brand_logo_size);
        logoView.setLayoutParams(new LinearLayout.LayoutParams(logoSize, logoSize));
        if (!BuildConfig.IS_ALPHA_DEV) row.addView(logoView);

        LinearLayout balanceSlot = new LinearLayout(this);
        balanceSlot.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        balanceSlot.setLayoutParams(new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.MATCH_PARENT,
                1f
        ));
        headerBalancesView = new LinearLayout(this);
        headerBalancesView.setId(R.id.header_balances);
        headerBalancesView.setOrientation(LinearLayout.HORIZONTAL);
        headerBalancesView.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        headerBalancesView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout ertGroup = headerTokenGroup(
                R.id.header_ert_group,
                R.id.header_ert_icon,
                R.drawable.header_token_ert,
                R.string.ert_token_content_description,
                R.id.header_ert_value
        );
        headerErtIconView = ertGroup.findViewById(R.id.header_ert_icon);
        headerErtValueView = ertGroup.findViewById(R.id.header_ert_value);
        ertGroup.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                0f
        ));
        headerBalancesView.addView(ertGroup);

        LinearLayout eruGroup = headerTokenGroup(
                R.id.header_eru_group,
                R.id.header_eru_icon,
                R.drawable.header_token_eru,
                R.string.eru_token_content_description,
                R.id.header_eru_value
        );
        LinearLayout.LayoutParams eruParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                0f
        );
        eruParams.setMarginStart(dimensionPixelSize(R.dimen.space_xs));
        eruGroup.setLayoutParams(eruParams);
        headerEruIconView = eruGroup.findViewById(R.id.header_eru_icon);
        headerEruValueView = eruGroup.findViewById(R.id.header_eru_value);
        headerBalancesView.addView(eruGroup);
        resetHeaderBalances();

        balanceSlot.addView(headerBalancesView);
        row.addView(balanceSlot);
        if (BuildConfig.IS_ALPHA_DEV) {
            ImageView walletEntry = new ImageView(this);
            walletEntry.setId(R.id.wallet_entry);
            walletEntry.setImageResource(R.drawable.ic_wallet_outline);
            walletEntry.setColorFilter(accentColor);
            walletEntry.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
            walletEntry.setPadding(dp(9), dp(9), dp(9), dp(9));
            walletEntry.setContentDescription("Open wallet");
            walletEntry.setTooltipText("Wallet");
            walletEntry.setClickable(true);
            walletEntry.setFocusable(true);
            walletEntry.setOnClickListener(view -> selectMode(Mode.WALLET));
            LinearLayout.LayoutParams walletParams = new LinearLayout.LayoutParams(dp(44), dp(44));
            walletParams.setMarginStart(dp(4));
            row.addView(walletEntry, walletParams);
        }
        return row;
    }

    private LinearLayout headerTokenGroup(
            int groupId,
            int iconId,
            int drawableId,
            int contentDescriptionId,
            int valueId
    ) {
        LinearLayout group = new LinearLayout(this);
        group.setId(groupId);
        group.setOrientation(LinearLayout.HORIZONTAL);
        group.setGravity(Gravity.CENTER_VERTICAL);

        ImageView icon = new ImageView(this);
        icon.setId(iconId);
        icon.setImageResource(drawableId);
        icon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        icon.setContentDescription(getString(contentDescriptionId));
        int iconSize = BuildConfig.IS_ALPHA_DEV ? dp(16) :
                dimensionPixelSize(R.dimen.header_token_icon_size);
        icon.setLayoutParams(new LinearLayout.LayoutParams(iconSize, iconSize));
        group.addView(icon);

        TextView value = new TextView(this);
        value.setId(valueId);
        value.setText("--");
        value.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        value.setTextColor(textColor);
        value.setTypeface(null, Typeface.BOLD);
        setTokenTextSize(value, R.dimen.text_label);
        value.setSingleLine(true);
        value.setAutoSizeTextTypeUniformWithConfiguration(
                8,
                12,
                1,
                TypedValue.COMPLEX_UNIT_SP
        );
        LinearLayout.LayoutParams valueParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                0f
        );
        valueParams.setMarginStart(dimensionPixelSize(R.dimen.space_xs));
        value.setLayoutParams(valueParams);
        group.addView(value);
        return group;
    }

    private void resetHeaderBalances() {
        headerErtValueView.setText("--");
        headerEruValueView.setText("--");
        setHeaderBalanceAppearance(false);
    }

    private void renderHeaderBalances() {
        if (currentProfile == null || !currentServerValuesKnown) {
            resetHeaderBalances();
            return;
        }
        headerErtValueView.setText(currentProfile.ertBalanceDisplay());
        headerEruValueView.setText(currentProfile.eruBalanceDisplay());
        setHeaderBalanceAppearance(currentProfileStale);
    }

    private void setHeaderBalanceAppearance(boolean stale) {
        int valueColor = stale ? mutedColor : textColor;
        float iconAlpha = stale ? 0.6f : 1f;
        headerErtValueView.setTextColor(valueColor);
        headerEruValueView.setTextColor(valueColor);
        headerErtIconView.setAlpha(iconAlpha);
        headerEruIconView.setAlpha(iconAlpha);
    }

    private LinearLayout stepStatusBlock() {
        LinearLayout block = new LinearLayout(this);
        stepStatusBlockView = block;
        block.setId(R.id.step_status_block);
        block.setOrientation(LinearLayout.VERTICAL);
        block.setGravity(Gravity.CENTER_HORIZONTAL);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dimensionPixelSize(R.dimen.space_xl);
        params.bottomMargin = dimensionPixelSize(R.dimen.space_lg);
        block.setLayoutParams(params);

        stepProgressView = new TextView(this);
        stepProgressView.setId(R.id.step_progress);
        stepProgressView.setText("0 / -- steps");
        TextView action = stepProgressView;
        action.setGravity(Gravity.CENTER);
        setTokenTextSize(action, R.dimen.text_body);
        action.setTextColor(textColor);
        action.setTypeface(null, Typeface.BOLD);
        action.setBackground(new BorderDrawable(
                outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_control),
                panelColor
        ));
        action.setPadding(
                dimensionPixelSize(R.dimen.space_lg),
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.space_lg),
                dimensionPixelSize(R.dimen.space_sm)
        );
        action.setMinHeight(dimensionPixelSize(R.dimen.touch_target));
        action.setMinWidth(dp(150));
        action.setOnClickListener(view -> selectMode(Mode.WALK));
        block.addView(action);

        stepStatusView = new TextView(this);
        stepStatusView.setText(stepTrackingState.message());
        stepStatusView.setGravity(Gravity.CENTER);
        setTokenTextSize(stepStatusView, R.dimen.text_label);
        stepStatusView.setTextColor(mutedColor);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        statusParams.topMargin = dimensionPixelSize(R.dimen.space_sm);
        stepStatusView.setLayoutParams(statusParams);
        block.addView(stepStatusView);
        return block;
    }

    private LinearLayout modeContentPanel() {
        LinearLayout panel = new LinearLayout(this);
        modeContentPanelView = panel;
        panel.setId(R.id.mode_content);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        int panelInset = dimensionPixelSize(R.dimen.space_lg);
        panel.setPadding(panelInset, panelInset, panelInset, panelInset);
        panel.setBackground(new BorderDrawable(
                outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_panel),
                panelColor
        ));
        panel.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
        ));

        panelTitleView = new TextView(this);
        panelTitleView.setText("Loading home");
        panelTitleView.setGravity(Gravity.CENTER);
        setTokenTextSize(panelTitleView, R.dimen.text_title);
        panelTitleView.setTextColor(textColor);
        panelTitleView.setTypeface(null, Typeface.BOLD);
        panel.addView(panelTitleView);

        panelBodyView = new TextView(this);
        panelBodyView.setText("Loading profile, ERT balance, and today progress.");
        panelBodyView.setGravity(Gravity.CENTER);
        setTokenTextSize(panelBodyView, R.dimen.text_body);
        panelBodyView.setTextColor(mutedColor);
        panelBodyView.setPadding(
                0,
                dimensionPixelSize(R.dimen.space_md),
                0,
                dimensionPixelSize(R.dimen.space_md)
        );
        panelBodyView.setMaxLines(4);
        panel.addView(panelBodyView);

        copperRingStatusView = new TextView(this);
        copperRingStatusView.setId(R.id.copper_ring_status);
        copperRingStatusView.setGravity(Gravity.CENTER);
        setTokenTextSize(copperRingStatusView, R.dimen.text_caption);
        copperRingStatusView.setTextColor(mutedColor);
        copperRingStatusView.setVisibility(View.GONE);

        copperRingArtworkView = new ImageView(this);
        copperRingArtworkView.setId(R.id.copper_ring_artwork);
        copperRingArtworkView.setImageResource(R.drawable.copper_ring_placeholder);
        copperRingArtworkView.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        copperRingArtworkView.setContentDescription("Cooper ring");
        copperRingArtworkView.setVisibility(View.GONE);
        copperRingArtworkView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
        ));
        copperRingArtworkView.setOnClickListener(view -> openEquippedCopperRingDetail());
        panel.addView(copperRingArtworkView);

        copperRingInventoryListView = new LinearLayout(this);
        copperRingInventoryListView.setId(R.id.copper_ring_inventory_list);
        copperRingInventoryListView.setOrientation(LinearLayout.VERTICAL);
        copperRingInventoryListView.setPadding(0, 0, 0, dimensionPixelSize(R.dimen.space_sm));

        copperRingInventoryView = new ScrollView(this);
        copperRingInventoryView.setId(R.id.copper_ring_inventory);
        copperRingInventoryView.setFillViewport(true);
        copperRingInventoryView.setVisibility(View.GONE);
        copperRingInventoryView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
        ));
        copperRingInventoryView.addView(copperRingInventoryListView);
        panel.addView(copperRingInventoryView);

        copperRingDetailMetricsView = new LinearLayout(this);
        copperRingDetailMetricsView.setId(R.id.copper_ring_detail_metrics);
        copperRingDetailMetricsView.setOrientation(LinearLayout.VERTICAL);
        copperRingDetailMetricsView.setGravity(Gravity.CENTER_HORIZONTAL);
        copperRingDetailMetricsView.setPadding(
                dimensionPixelSize(R.dimen.ring_detail_table_inset),
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.ring_detail_table_inset),
                0
        );
        copperRingDetailScrollView = new ScrollView(this);
        copperRingDetailScrollView.setVisibility(View.GONE);
        copperRingDetailScrollView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        copperRingDetailScrollView.addView(copperRingDetailMetricsView);
        panel.addView(copperRingDetailScrollView);
        panel.addView(copperRingStatusView);

        copperRingRetryView = formButton("Retry Cooper ring");
        copperRingRetryView.setId(R.id.copper_ring_retry);
        copperRingRetryView.setVisibility(View.GONE);
        copperRingRetryView.setOnClickListener(view -> retryCopperRingLoad());
        panel.addView(copperRingRetryView);

        raffleDrawResultView = metricText("", "");
        raffleDrawResultView.setText("");
        raffleDrawResultView.setSingleLine(false);
        raffleDrawResultView.setVisibility(View.GONE);
        panel.addView(raffleDrawResultView);
        panel.addView(rafflePoolsList());

        alphaMarketplaceScrollView = new ScrollView(this);
        alphaMarketplaceScrollView.setFillViewport(true);
        alphaMarketplaceScrollView.setVisibility(View.GONE);
        alphaMarketplaceScrollView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        alphaMarketplaceListView = new LinearLayout(this);
        alphaMarketplaceListView.setId(R.id.marketplace_list);
        alphaMarketplaceListView.setOrientation(LinearLayout.VERTICAL);
        alphaMarketplaceScrollView.addView(alphaMarketplaceListView);
        panel.addView(alphaMarketplaceScrollView);

        registrationDisplayNameInput = textInput("Display name", false);
        registrationDisplayNameInput.setId(R.id.registration_display_name);
        usernameInput = textInput("Username", false);
        passwordInput = textInput("Password", true);
        registrationPasswordConfirmationInput = textInput("Confirm password", true);
        registrationPasswordConfirmationInput.setId(R.id.registration_password_confirmation);
        loginButton = formButton("Sign in");
        loginButton.setId(R.id.auth_submit);
        authModeButton = outlineButton(getString(R.string.create_account));
        authModeButton.setId(R.id.auth_mode_toggle);
        loginMessageView = metricText("Login", "");
        loginButton.setOnClickListener(view -> submitLogin());
        authModeButton.setOnClickListener(view -> setRegistrationMode(!registrationMode));
        panel.addView(registrationDisplayNameInput);
        panel.addView(usernameInput);
        panel.addView(passwordInput);
        panel.addView(registrationPasswordConfirmationInput);
        panel.addView(loginButton);
        panel.addView(authModeButton);
        panel.addView(loginMessageView);

        balanceView = metricText("ERT balance", "--");
        stepsView = metricText("On this phone today", "--");
        acceptedStepsView = metricText("Accepted by server today", "--");
        earnedView = metricText("ERT earned today", "--");
        raffleView = metricText("Draws today", "--");
        trackingView = metricText("Current reward window", "--");
        syncStatusView = metricText("Delivery", "--");
        stepsView.setId(R.id.local_steps_today);
        acceptedStepsView.setId(R.id.accepted_steps_today);
        trackingView.setId(R.id.reward_window_steps);
        syncStatusView.setId(R.id.delivery_status);
        acceptedStepsView.setSingleLine(false);
        acceptedStepsView.setMaxLines(2);
        trackingView.setSingleLine(false);
        trackingView.setMaxLines(2);
        syncStatusView.setSingleLine(false);
        syncStatusView.setMaxLines(7);
        setTokenTextSize(syncStatusView, R.dimen.text_label);
        panel.addView(balanceView);
        panel.addView(stepsView);
        panel.addView(acceptedStepsView);
        panel.addView(earnedView);
        panel.addView(raffleView);
        panel.addView(trackingView);
        panel.addView(syncStatusView);

        activityHistoryView = formButton(getString(R.string.activity_history));
        activityHistoryView.setId(R.id.activity_history);
        activityHistoryView.setOnClickListener(view -> showActivityHistoryDialog());
        panel.addView(activityHistoryView);

        drawHistoryView = outlineButton("Draw history");
        drawHistoryView.setId(R.id.profile_draw_history_entry);
        drawHistoryView.setVisibility(View.GONE);
        drawHistoryView.setOnClickListener(view -> showAlphaDrawHistory());
        panel.addView(drawHistoryView);

        changeNameView = outlineButton(getString(R.string.change_name));
        changeNameView.setId(R.id.change_name);
        changeNameView.setOnClickListener(view -> showChangeNameDialog());
        panel.addView(changeNameView);

        changePasswordView = outlineButton(getString(R.string.change_password));
        changePasswordView.setId(R.id.change_password);
        changePasswordView.setOnClickListener(view -> showChangePasswordDialog());
        panel.addView(changePasswordView);

        recoveryPhraseView = outlineButton("View recovery phrase");
        recoveryPhraseView.setVisibility(View.GONE);
        panel.addView(recoveryPhraseView);

        signOutView = outlineButton(getString(R.string.sign_out));
        signOutView.setId(R.id.sign_out);
        signOutView.setTextColor(errorColor);
        signOutView.setOnClickListener(view -> submitLogout());
        panel.addView(signOutView);

        retryView = new TextView(this);
        retryView.setId(R.id.profile_retry);
        retryView.setText("Retry");
        retryView.setGravity(Gravity.CENTER);
        setTokenTextSize(retryView, R.dimen.text_body);
        retryView.setTextColor(accentColor);
        retryView.setTypeface(null, Typeface.BOLD);
        retryView.setPadding(0, dimensionPixelSize(R.dimen.space_md), 0, 0);
        retryView.setMinHeight(dimensionPixelSize(R.dimen.touch_target));
        retryView.setOnClickListener(view -> loadHomeProfile());
        panel.addView(retryView);

        profileVersionView = new TextView(this);
        profileVersionView.setId(R.id.profile_version);
        profileVersionView.setText(getString(
                R.string.profile_version,
                BuildConfig.VERSION_NAME
        ));
        profileVersionView.setGravity(Gravity.CENTER);
        setTokenTextSize(profileVersionView, R.dimen.text_caption);
        profileVersionView.setTextColor(disabledTextColor);
        profileVersionView.setSingleLine(true);
        profileVersionView.setPadding(
                0,
                dimensionPixelSize(R.dimen.space_sm),
                0,
                0
        );
        panel.addView(profileVersionView);
        hideLoginForm();
        return panel;
    }

    private ScrollView rafflePoolsList() {
        rafflePoolsScrollView = new ScrollView(this);
        rafflePoolsScrollView.setFillViewport(true);
        rafflePoolsScrollView.setVisibility(View.GONE);
        rafflePoolsScrollView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
        ));

        rafflePoolsContainer = new LinearLayout(this);
        rafflePoolsContainer.setOrientation(LinearLayout.VERTICAL);
        rafflePoolsContainer.setPadding(
                0,
                dimensionPixelSize(R.dimen.space_xs),
                0,
                dimensionPixelSize(R.dimen.space_xs)
        );
        rafflePoolsScrollView.addView(rafflePoolsContainer, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        return rafflePoolsScrollView;
    }


    private TextView metricText(String label, String value) {
        TextView view = new TextView(this);
        view.setText(label + ": " + value);
        view.setGravity(Gravity.CENTER);
        setTokenTextSize(view, R.dimen.text_body);
        view.setTextColor(textColor);
        view.setSingleLine(false);
        view.setMaxLines(3);
        view.setPadding(0, dimensionPixelSize(R.dimen.space_xs), 0, dimensionPixelSize(R.dimen.space_xs));
        return view;
    }

    private EditText textInput(String hint, boolean password) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextColor(textColor);
        input.setHintTextColor(disabledTextColor);
        setTokenTextSize(input, R.dimen.text_body);
        input.setSingleLine(true);
        input.setPadding(
                dimensionPixelSize(R.dimen.space_md),
                0,
                dimensionPixelSize(R.dimen.space_md),
                0
        );
        input.setBackground(new BorderDrawable(
                outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_control),
                elevatedPanelColor
        ));
        input.setInputType(password
                ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
                : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dimensionPixelSize(R.dimen.touch_target)
        );
        params.topMargin = dimensionPixelSize(R.dimen.space_sm);
        input.setLayoutParams(params);
        return input;
    }

    private TextView formButton(String label) {
        TextView button = new TextView(this);
        button.setText(label);
        button.setGravity(Gravity.CENTER);
        setTokenTextSize(button, R.dimen.text_body);
        button.setTextColor(onAccentColor);
        button.setTypeface(null, Typeface.BOLD);
        button.setSingleLine(true);
        button.setAutoSizeTextTypeUniformWithConfiguration(
                10,
                14,
                1,
                TypedValue.COMPLEX_UNIT_SP
        );
        button.setBackground(new BorderDrawable(
                accentColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_control),
                accentColor
        ));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dimensionPixelSize(R.dimen.touch_target)
        );
        params.topMargin = dimensionPixelSize(R.dimen.space_md);
        button.setLayoutParams(params);
        return button;
    }

    private TextView outlineButton(String label) {
        TextView button = formButton(label);
        button.setTextColor(textColor);
        button.setBackground(new BorderDrawable(
                outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_control),
                elevatedPanelColor
        ));
        LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) button.getLayoutParams();
        params.topMargin = dimensionPixelSize(R.dimen.space_sm);
        button.setLayoutParams(params);
        return button;
    }

    private LinearLayout modeTabs() {
        LinearLayout tabs = new LinearLayout(this);
        modeTabsView = tabs;
        tabs.setId(R.id.mode_tabs);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        tabs.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dimensionPixelSize(R.dimen.space_lg);
        tabs.setLayoutParams(params);

        drawTab = modeTab("Draw", Mode.DRAW, false);
        drawTab.setId(R.id.mode_draw);
        homeTab = modeTab("Home", Mode.WALK, false);
        homeTab.setId(R.id.mode_home);
        ringsTab = modeTab("Rings", Mode.RINGS, false);
        ringsTab.setId(R.id.mode_rings);
        marketplaceTab = modeTab("Market", Mode.MARKETPLACE, false);
        marketplaceTab.setId(R.id.mode_marketplace);
        marketplaceTab.setVisibility(BuildConfig.IS_ALPHA_DEV ? View.VISIBLE : View.GONE);
        tabs.addView(drawTab);
        tabs.addView(homeTab);
        tabs.addView(ringsTab);
        tabs.addView(marketplaceTab);
        updateModeTabs();
        return tabs;
    }

    private void loadHomeProfile() {
        if (!sessionStore.hasAccessToken()) {
            clearProfileUiState();
            showLoginForm(null);
            return;
        }
        renderLoading();
        new Thread(() -> {
            HomeRepository.Result result = homeRepository.loadHomeProfile();
            runOnUiThread(() -> renderHomeResult(result));
        }).start();
    }

    private void renderLoading() {
        hideLoginForm();
        currentProfile = null;
        currentProfileStale = false;
        currentServerValuesKnown = false;
        copperRingRequestGeneration++;
        copperRingUiState = null;
        copperRingOwnerId = null;
        copperRingDetailId = null;
        mainHandler.removeCallbacks(staleProfileRetry);
        resetHeaderBalances();
        panelTitleView.setText("Loading home");
        panelTitleView.setTextColor(textColor);
        panelBodyView.setText("Loading profile, ERT balance, and today progress.");
        panelBodyView.setTextColor(mutedColor);
        balanceView.setText("ERT balance: --");
        stepsView.setText("On this phone today: --");
        acceptedStepsView.setText("Accepted by server today: --");
        earnedView.setText("ERT earned today: --");
        raffleView.setText("Draws today: --");
        trackingView.setText("Current reward window: --");
        syncStatusView.setText("Delivery: --");
        stepStatusView.setText(stepTrackingState.message());
        retryView.setEnabled(false);
        retryView.setTextColor(disabledTextColor);
        updateModeTabs();
        updateModeContentVisibility();
    }

    private void renderHomeResult(HomeRepository.Result result) {
        retryView.setEnabled(true);
        retryView.setTextColor(accentColor);

        if (result.isSuccess()) {
            boolean copperOwnerChanged = !result.profile().userId().equals(copperRingOwnerId);
            currentProfile = result.profile();
            stepDisplaySnapshotStore.saveServerDailyStepCap(
                    currentProfile.userId(), currentProfile.dailyStepCap()
            );
            currentProfileStale = result.isStale();
            currentServerValuesKnown = result.serverValuesKnown();
            if (copperOwnerChanged) {
                copperRingOwnerId = currentProfile.userId();
                copperRingUiState = CopperRingUiState.loadingWalk();
            }
            ensureStepTrackingAfterAuth();
            refreshSyncStatusAsync();
            SyncStatusSnapshot syncSnapshot = syncStatusStore.snapshot(currentProfile.userId());
            passiveProfileRefreshGate.observe(syncSnapshot.lastSuccessfulSyncAtMs());
            renderSelectedMode();
            if (copperOwnerChanged) {
                loadEquippedCopperRing();
            }
            scheduleStaleProfileRetry();
            return;
        }

        currentProfile = null;
        currentProfileStale = false;
        currentServerValuesKnown = false;
        mainHandler.removeCallbacks(staleProfileRetry);
        resetHeaderBalances();
        if (result.errorKind() == HomeRepository.ErrorKind.UNAUTHENTICATED
                || result.errorKind() == HomeRepository.ErrorKind.SESSION_EXPIRED) {
            showLoginForm(result.errorMessage());
            return;
        }
        hideLoginForm();
        panelTitleView.setText(errorTitle(result.errorKind()));
        panelTitleView.setTextColor(errorColor);
        panelBodyView.setText(result.errorMessage());
        panelBodyView.setTextColor(mutedColor);
        balanceView.setText("ERT balance: --");
        stepsView.setText("On this phone today: --");
        acceptedStepsView.setText("Accepted by server today: --");
        earnedView.setText("ERT earned today: --");
        raffleView.setText("Draws today: --");
        trackingView.setText("Current reward window: --");
        syncStatusView.setText("Delivery: --");
        stepStatusView.setText(stepTrackingState.message());
        updateModeTabs();
        updateModeContentVisibility();
        retryView.setVisibility(View.VISIBLE);
    }

    private void selectMode(Mode mode) {
        if (BuildConfig.IS_ALPHA_DEV) {
            if (mode == Mode.WALLET) {
                startActivity(new Intent().setClassName(this,
                        "xyz.etherings.player.alpha.AlphaWalletActivity"));
                return;
            }
            if (mode == Mode.RINGS && selectedMode != Mode.RINGS) {
                alphaStarterPendingPolls = 0;
            }
            if (mode == Mode.RINGS && selectedMode == Mode.RINGS) {
                alphaCooperDetail = false;
                alphaCooperDetailId = null;
                alphaSilverDetailMint = null;
                alphaOpenEquippedDetailOnLoad = false;
            }
            if (mode == Mode.MARKETPLACE && selectedMode != Mode.MARKETPLACE)
                alphaMarketplaceMyListings = false;
            alphaSilverGeneration++;
            selectedMode = mode;
            renderAlphaMode();
            if (mode == Mode.WALK || mode == Mode.ACTIVITY) loadAlphaEconomy();
            return;
        }
        if (currentProfile == null) {
            showLoginForm(null);
            return;
        }
        selectedMode = mode;
        renderSelectedMode();
        if (mode == Mode.WALK
                && (copperRingUiState == null
                || copperRingUiState.screen() != CopperRingUiState.Screen.WALK)) {
            loadEquippedCopperRing();
        } else if (mode == Mode.RINGS
                && (copperRingUiState == null
                || copperRingUiState.screen() != CopperRingUiState.Screen.INVENTORY)) {
            loadCopperRingInventory();
        }
    }

    private void renderAlphaMode() {
        String email = getIntent().getStringExtra(ALPHA_VERIFIED_EMAIL);
        if (email == null || email.isEmpty()) {
            startActivity(new Intent().setClassName(this,
                    "xyz.etherings.player.alpha.AlphaAuthActivity"));
            finish();
            return;
        }
        updateModeTabs();
        homeShellView.setBackgroundColor(backgroundColor);
        modeContentPanelView.setBackground(new BorderDrawable(outlineColor,
                dimension(R.dimen.border_standard), dimension(R.dimen.radius_panel),
                panelColor));
        if (selectedMode != Mode.RINGS) alphaOpenEquippedDetailOnLoad = false;
        boolean showSteps = selectedMode == Mode.WALK || selectedMode == Mode.ACTIVITY;
        stepStatusBlockView.setVisibility(showSteps ? View.VISIBLE : View.GONE);
        headerBalancesView.setVisibility(View.VISIBLE);
        renderAlphaHeaderBalances();
        registrationDisplayNameInput.setVisibility(View.GONE);
        usernameInput.setVisibility(View.GONE);
        passwordInput.setVisibility(View.GONE);
        registrationPasswordConfirmationInput.setVisibility(View.GONE);
        loginButton.setVisibility(View.GONE);
        authModeButton.setVisibility(View.GONE);
        loginMessageView.setVisibility(View.GONE);
        copperRingArtworkView.setVisibility(View.GONE);
        copperRingInventoryView.setVisibility(View.GONE);
        copperRingDetailScrollView.setVisibility(View.GONE);
        copperRingStatusView.setVisibility(View.GONE);
        copperRingRetryView.setVisibility(View.GONE);
        panelTitleView.setVisibility(View.VISIBLE);
        panelBodyView.setVisibility(View.VISIBLE);
        rafflePoolsScrollView.setVisibility(View.GONE);
        alphaMarketplaceScrollView.setVisibility(View.GONE);
        alphaMarketplaceGeneration++;
        raffleDrawResultView.setVisibility(View.GONE);
        balanceView.setVisibility(View.GONE);
        stepsView.setVisibility(selectedMode == Mode.ACTIVITY ? View.VISIBLE : View.GONE);
        acceptedStepsView.setVisibility(selectedMode == Mode.ACTIVITY ? View.VISIBLE : View.GONE);
        earnedView.setVisibility(selectedMode == Mode.ACTIVITY ? View.VISIBLE : View.GONE);
        raffleView.setVisibility(View.GONE);
        trackingView.setVisibility(selectedMode == Mode.ACTIVITY ? View.VISIBLE : View.GONE);
        syncStatusView.setVisibility(selectedMode == Mode.ACTIVITY ? View.VISIBLE : View.GONE);
        retryView.setVisibility(View.GONE);
        changeNameView.setVisibility(View.GONE);
        changePasswordView.setVisibility(selectedMode == Mode.PROFILE ? View.VISIBLE : View.GONE);
        changePasswordView.setOnClickListener(view -> {
            Intent password = new Intent().setClassName(this,
                    "xyz.etherings.player.alpha.AlphaWalletActivity");
            password.putExtra(ALPHA_CHANGE_PASSWORD, true);
            startActivity(password);
        });
        recoveryPhraseView.setVisibility(selectedMode == Mode.PROFILE ? View.VISIBLE : View.GONE);
        recoveryPhraseView.setOnClickListener(view -> {
            Intent phrase = new Intent().setClassName(this,
                    "xyz.etherings.player.alpha.AlphaWalletActivity");
            phrase.putExtra(ALPHA_REVEAL_PHRASE, true);
            startActivity(phrase);
        });
        activityHistoryView.setVisibility(selectedMode == Mode.PROFILE || selectedMode == Mode.ACTIVITY
                ? View.VISIBLE : View.GONE);
        drawHistoryView.setVisibility(selectedMode == Mode.PROFILE ? View.VISIBLE : View.GONE);
        activityHistoryView.setOnClickListener(view -> {
            if (selectedMode == Mode.PROFILE) selectMode(Mode.ACTIVITY);
            else showActivityHistoryDialog();
        });
        signOutView.setVisibility(selectedMode == Mode.PROFILE ? View.VISIBLE : View.GONE);
        signOutView.setOnClickListener(view -> {
            Intent logout = new Intent().setClassName(this,
                    "xyz.etherings.player.alpha.AlphaWalletActivity");
            logout.putExtra(ALPHA_LOGOUT, true);
            startActivity(logout);
        });
        profileVersionView.setVisibility(selectedMode == Mode.PROFILE ? View.VISIBLE : View.GONE);
        profileVersionView.setText("EtheRings Alpha v. " + BuildConfig.VERSION_NAME);
        if (selectedMode == Mode.PROFILE) {
            panelTitleView.setText("Account verified");
            panelBodyView.setText(email);
        } else if (selectedMode == Mode.ACTIVITY) {
            panelTitleView.setText("Activity");
            panelBodyView.setText("Account daily report and this phone's step delivery.");
            acceptedStepsView.setText("Accepted by server today: --");
            earnedView.setText("ERT earned today: --");
            loadAlphaActivitySummary();
        } else if (selectedMode == Mode.DRAW) {
            panelTitleView.setText("Draw");
            panelBodyView.setVisibility(View.GONE);
            rafflePoolsScrollView.setVisibility(View.VISIBLE);
            rafflePoolsContainer.removeAllViews();
            try {
                View draw = (View) Class.forName("xyz.etherings.player.alpha.AlphaDrawPanel")
                        .getConstructor(android.content.Context.class, Runnable.class)
                        .newInstance(this, (Runnable) this::loadAlphaEconomy);
                rafflePoolsContainer.addView(draw);
            } catch (Exception error) {
                panelBodyView.setVisibility(View.VISIBLE);
                panelBodyView.setText("Draw is unavailable.");
                rafflePoolsScrollView.setVisibility(View.GONE);
            }
        } else if (selectedMode == Mode.RINGS) {
            panelTitleView.setText("Rings");
            panelBodyView.setText("Loading Silver inventory...");
            loadAlphaSilverInventory();
        } else if (selectedMode == Mode.MARKETPLACE) {
            panelTitleView.setText("Marketplace");
            panelBodyView.setVisibility(View.GONE);
            alphaMarketplaceScrollView.setVisibility(View.VISIBLE);
            renderAlphaMarketplaceSection();
        } else {
            panelTitleView.setText("Home");
            panelBodyView.setText("Loading equipped Ring...");
            loadAlphaHome();
        }
        renderAlphaStepReceipts();
    }

    private void loadAlphaActivitySummary() {
        AlphaSessionStore.VerifiedSession session = new AlphaSessionStore(this).verified();
        if (session == null || alphaActivityLoading) return;
        alphaActivityLoading = true;
        LocalDate today = LocalDate.now();
        int request = ++alphaActivityGeneration;
        long deliveryAtRequest = syncStatusStore.snapshot(session.ownerId()).lastSuccessfulSyncAtMs();
        alphaEconomyIo.execute(() -> {
            ActivityHistoryRepository.Result result;
            try {
                result = (ActivityHistoryRepository.Result) Class.forName(
                        "xyz.etherings.player.alpha.AlphaActivityHistoryClient")
                        .getMethod("load", android.content.Context.class, LocalDate.class)
                        .invoke(null, this, today);
            } catch (Exception error) {
                result = ActivityHistoryRepository.Result.error(
                        ActivityHistoryRepository.ErrorKind.ERROR, "Activity is unavailable.");
            }
            ActivityHistoryRepository.Result loaded = result;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || request != alphaActivityGeneration) return;
                alphaActivityLoading = false;
                if (selectedMode != Mode.ACTIVITY || !today.equals(LocalDate.now())) return;
                AlphaSessionStore.VerifiedSession current = new AlphaSessionStore(this).verified();
                if (current == null || !session.lineage().equals(current.lineage()) ||
                        !session.ownerId().equals(current.ownerId())) return;
                alphaActivityDeliveryAt = deliveryAtRequest;
                if (!loaded.isSuccess()) {
                    panelBodyView.setText("Account daily report unavailable; local delivery below.");
                    return;
                }
                DailyActivityItem todayRow = null;
                for (DailyActivityItem row : loaded.items()) {
                    if (today.equals(row.date())) { todayRow = row; break; }
                }
                acceptedStepsView.setText("Accepted by server today: " +
                        (todayRow == null ? 0 : todayRow.acceptedSteps()));
                earnedView.setText("ERT earned today: " +
                        (todayRow == null ? "0.00" : todayRow.earnedErtDisplay()));
                if (syncStatusStore.snapshot(session.ownerId()).lastSuccessfulSyncAtMs()
                        > alphaActivityDeliveryAt) loadAlphaActivitySummary();
            });
        });
    }

    private void renderAlphaStepReceipts() {
        if (!BuildConfig.IS_ALPHA_DEV || stepProgressView == null || syncStatusStore == null) return;
        AlphaSessionStore.VerifiedSession session = new AlphaSessionStore(this).verified();
        if (session == null) {
            alphaEconomy = null;
            resetHeaderBalances();
            stepStatusBlockView.setVisibility(View.GONE);
            stepsView.setVisibility(View.GONE);
            trackingView.setVisibility(View.GONE);
            syncStatusView.setVisibility(View.GONE);
            return;
        }
        StepCounterSnapshot local = stepDisplaySnapshotStore.snapshot(session.ownerId());
        SyncStatusSnapshot sync = syncStatusStore.snapshot(session.ownerId());
        String today = LocalDate.now().toString();
        if (alphaEconomy != null && (!session.ownerId().equals(alphaEconomy.ownerId())
                || !today.equals(alphaEconomy.date()))) alphaEconomy = null;
        String lastDelivery = sync.lastSuccessfulSyncAtMs() <= 0L ? "never"
                : DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                        .format(new Date(sync.lastSuccessfulSyncAtMs()));
        AlphaStepReceiptPresentation presentation = AlphaStepReceiptPresentation.from(
                local.dailySteps(), local.rewardWindowSteps(), local.dailyDate(),
                today, sync, lastDelivery,
                alphaEconomy == null ? null : alphaEconomy.dailyStepCap());
        stepProgressView.setText(presentation.progress());
        renderAlphaHeaderBalances();
        stepsView.setText(presentation.localSteps());
        trackingView.setText(presentation.rewardWindow());
        syncStatusView.setText(presentation.deliveryStatus());
        boolean activityPermissionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                || checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
        boolean notificationPermissionMissing = Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED;
        stepTrackingState = StepTrackingState.from(stepSensorCapability, activityPermissionGranted,
                local.eventCount(), local.lastSensorUpdateAtMs(), System.currentTimeMillis(),
                notificationPermissionMissing);
        stepStatusView.setText(stepTrackingState.message());
        if (sync.lastSuccessfulSyncAtMs() > alphaEconomyDeliveryAt && !alphaEconomyLoading)
            loadAlphaEconomy();
        if (selectedMode == Mode.ACTIVITY && sync.lastSuccessfulSyncAtMs()
                > alphaActivityDeliveryAt && !alphaActivityLoading) loadAlphaActivitySummary();
    }

    private void renderAlphaHeaderBalances() {
        headerErtValueView.setText(alphaEconomy == null ? "--" : alphaEconomy.ertDisplay());
        headerEruValueView.setText(alphaEconomy == null || alphaEconomy.eruDisplay() == null
                ? "--" : alphaEconomy.eruDisplay());
        setHeaderBalanceAppearance(false);
    }

    private void loadAlphaEconomy() {
        AlphaSessionStore.VerifiedSession session = new AlphaSessionStore(this).verified();
        if (session == null) return;
        if (alphaEconomyLoading) {
            alphaEconomyRefreshPending = true;
            return;
        }
        alphaEconomyLoading = true;
        int request = ++alphaEconomyGeneration;
        long deliveryAtRequest = syncStatusStore.snapshot(session.ownerId()).lastSuccessfulSyncAtMs();
        alphaEconomyIo.execute(() -> {
            AlphaHomeEconomySnapshot loaded = null;
            try {
                loaded = (AlphaHomeEconomySnapshot) Class.forName(
                        "xyz.etherings.player.alpha.AlphaHomeEconomyClient")
                        .getMethod("load", android.content.Context.class).invoke(null, this);
            } catch (Exception ignored) { }
            AlphaHomeEconomySnapshot result = loaded;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || request != alphaEconomyGeneration) return;
                alphaEconomyLoading = false;
                boolean refreshPending = alphaEconomyRefreshPending;
                alphaEconomyRefreshPending = false;
                AlphaSessionStore.VerifiedSession current = new AlphaSessionStore(this).verified();
                if (current == null || !session.lineage().equals(current.lineage()) ||
                        !session.ownerId().equals(current.ownerId())) {
                    alphaEconomy = null;
                    renderAlphaHeaderBalances();
                    if (refreshPending && current != null) loadAlphaEconomy();
                    return;
                }
                alphaEconomy = result;
                stepDisplaySnapshotStore.saveServerDailyStepCap(current.ownerId(),
                        result == null ? LocalDate.now().toString() : result.date(),
                        result == null ? null : result.dailyStepCap());
                alphaEconomyDeliveryAt = deliveryAtRequest;
                renderAlphaStepReceipts();
                if (refreshPending) loadAlphaEconomy();
            });
        });
    }

    private void loadAlphaHome() {
        int request = ++alphaSilverGeneration;
        alphaHomeRefreshing = true;
        copperRingArtworkView.setVisibility(View.GONE);
        copperRingRetryView.setVisibility(View.GONE);
        if (alphaRingEquipment != null && alphaHomeCoopers != null) renderAlphaHome();
        alphaScreenIo.execute(() -> {
            List<CopperRing> coopers = null;
            AlphaRingEquipmentSnapshot equipment = null;
            SilverInventorySnapshot inventory = null;
            Future<List<CopperRing>> cooperRead = alphaAssetReadIo.submit(() ->
                    (List<CopperRing>) Class.forName(
                            "xyz.etherings.player.alpha.AlphaStarterClient")
                            .getMethod("loadInventory", android.content.Context.class).invoke(null, this));
            Future<AlphaRingEquipmentSnapshot> equipmentRead = alphaAssetReadIo.submit(() ->
                    (AlphaRingEquipmentSnapshot) Class.forName(
                            "xyz.etherings.player.alpha.AlphaRingEquipmentClient")
                            .getMethod("load", android.content.Context.class).invoke(null, this));
            try {
                coopers = cooperRead.get();
                equipment = equipmentRead.get();
                if ("SILVER_RING".equals(equipment.selection.kind))
                    inventory = (SilverInventorySnapshot) Class.forName(
                            "xyz.etherings.player.alpha.AlphaSilverInventoryClient")
                            .getMethod("load", android.content.Context.class).invoke(null, this);
            } catch (Exception ignored) { }
            List<CopperRing> loadedCoopers = coopers;
            AlphaRingEquipmentSnapshot loadedEquipment = equipment;
            SilverInventorySnapshot loadedInventory = inventory;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || selectedMode != Mode.WALK ||
                        request != alphaSilverGeneration) return;
                if (loadedCoopers == null || loadedEquipment == null ||
                        ("SILVER_RING".equals(loadedEquipment.selection.kind) && loadedInventory == null)) {
                    alphaHomeRefreshing = false;
                    alphaRingEquipment = null;
                    alphaHomeCoopers = null;
                    alphaSilverInventory = null;
                    copperRingArtworkView.setVisibility(View.GONE);
                    panelBodyView.setVisibility(View.VISIBLE);
                    panelBodyView.setText("Equipped Ring unavailable; gameplay effects are not shown.");
                    copperRingRetryView.setText("Retry Ring");
                    copperRingRetryView.setOnClickListener(view -> loadAlphaHome());
                    copperRingRetryView.setVisibility(View.VISIBLE);
                    return;
                }
                if (loadedInventory != null) {
                    alphaSilverArtwork = matchingSilverArtwork(alphaSilverInventory,
                            loadedInventory, alphaSilverArtwork);
                    alphaSilverInventory = loadedInventory;
                }
                alphaHomeCoopers = loadedCoopers;
                alphaRingEquipment = loadedEquipment;
                alphaHomeRefreshing = false;
                renderAlphaHome();
            });
            if (loadedInventory != null) alphaSilverMediaIo.execute(() -> {
                Map<String, Bitmap> images = Collections.emptyMap();
                try {
                    images = (Map<String, Bitmap>) Class.forName(
                            "xyz.etherings.player.alpha.AlphaSilverArtwork")
                            .getMethod("load", android.content.Context.class, SilverInventorySnapshot.class)
                            .invoke(null, this, loadedInventory);
                } catch (Exception ignored) { }
                Map<String, Bitmap> loadedImages = images;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || selectedMode != Mode.WALK ||
                            request != alphaSilverGeneration) return;
                    alphaSilverArtwork = loadedImages;
                    renderAlphaHome();
                });
            });
            if (loadedCoopers != null && loadedEquipment != null &&
                    "COOPER".equals(loadedEquipment.selection.kind)) alphaSilverMediaIo.execute(() -> {
                Map<String, Bitmap> images = Collections.emptyMap();
                try {
                    images = (Map<String, Bitmap>) Class.forName(
                            "xyz.etherings.player.alpha.AlphaCooperArtwork")
                            .getMethod("load", android.content.Context.class, List.class)
                            .invoke(null, this, loadedCoopers);
                } catch (Exception ignored) { }
                Map<String, Bitmap> loadedImages = images;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || selectedMode != Mode.WALK ||
                            request != alphaSilverGeneration) return;
                    alphaCooperArtwork = loadedImages;
                    renderAlphaHome();
                });
            });
        });
    }

    private void renderAlphaHome() {
        if (alphaRingEquipment == null || alphaHomeCoopers == null) return;
        AlphaRingEquipmentSnapshot.Key selected = alphaRingEquipment.selection;
        copperRingRetryView.setText("Refresh Ring");
        copperRingRetryView.setOnClickListener(view -> loadAlphaHome());
        copperRingRetryView.setVisibility(View.GONE);
        panelTitleView.setVisibility(View.GONE);
        panelBodyView.setVisibility(View.GONE);
        if ("COOPER".equals(selected.kind)) {
            CopperRing ring = null;
            for (CopperRing candidate : alphaHomeCoopers)
                if (candidate.id().equals(selected.id)) { ring = candidate; break; }
            if (ring == null) {
                panelTitleView.setVisibility(View.VISIBLE);
                panelBodyView.setVisibility(View.VISIBLE);
                panelBodyView.setText("Selected Cooper Ring could not be verified.");
                copperRingRetryView.setVisibility(View.VISIBLE);
                copperRingArtworkView.setVisibility(View.GONE);
                return;
            }
            Bitmap image = alphaCooperArtwork.get(ring.visualVariantCode());
            if (image == null) {
                copperRingArtworkView.setImageResource(R.drawable.copper_ring_placeholder);
                panelBodyView.setVisibility(View.VISIBLE);
                panelBodyView.setText("Equipped Cooper Ring; artwork loading or unavailable.");
                copperRingRetryView.setVisibility(View.VISIBLE);
            } else copperRingArtworkView.setImageBitmap(image);
            copperRingArtworkView.setScaleType(ImageView.ScaleType.FIT_CENTER);
            copperRingArtworkView.setContentDescription("Equipped Cooper Ring, level " +
                    ring.level() + "; open Rings");
        } else {
            SilverInventorySnapshot.Asset selectedAsset = null;
            if (alphaSilverInventory != null) for (SilverInventorySnapshot.Asset asset :
                    alphaSilverInventory.assets()) {
                if (!asset.isBox() && selected.id.equals(asset.mint)) selectedAsset = asset;
            }
            if (!alphaRingEquipment.effectsEnabled || selectedAsset == null) {
                panelTitleView.setVisibility(View.VISIBLE);
                panelBodyView.setVisibility(View.VISIBLE);
                panelBodyView.setText(!alphaRingEquipment.effectsEnabled ?
                        "Selected Silver Ring: chain eligibility unverified; " +
                                "gameplay effects disabled." :
                        "Selected Silver Ring absent from verified inventory; " +
                                "gameplay effects are not shown.");
                copperRingRetryView.setVisibility(View.VISIBLE);
                copperRingArtworkView.setVisibility(View.GONE);
                return;
            }
            Bitmap image = alphaSilverArtwork.get(selected.id);
            if (image == null) {
                panelTitleView.setVisibility(View.VISIBLE);
                panelBodyView.setVisibility(View.VISIBLE);
                panelBodyView.setText("Equipped Silver Ring #" + selectedAsset.serial +
                        "; verified artwork unavailable.");
                copperRingRetryView.setVisibility(View.VISIBLE);
                copperRingArtworkView.setVisibility(View.GONE);
                return;
            }
            copperRingArtworkView.setImageBitmap(image);
            copperRingArtworkView.setScaleType(ImageView.ScaleType.FIT_CENTER);
            copperRingArtworkView.setContentDescription("Verified equipped Silver Ring #" +
                    selectedAsset.serial + "; open Rings");
        }
        copperRingArtworkView.setOnClickListener(view -> {
            if (alphaHomeRefreshing) return;
            alphaOpenEquippedDetailOnLoad = true;
            selectMode(Mode.RINGS);
        });
        copperRingArtworkView.setVisibility(View.VISIBLE);
        if (alphaHomeRefreshing) {
            panelBodyView.setText("Checking current Ring...");
            panelBodyView.setVisibility(View.VISIBLE);
        }
    }

    private void loadAlphaSilverInventory() {
        int request = ++alphaSilverGeneration;
        boolean reopenCooper = alphaCooperDetail;
        String reopenCooperId = alphaCooperDetailId;
        alphaInventoryRefreshing = true;
        alphaCooperDetail = false;
        alphaCooperDetailId = null;
        alphaSilverDetailMint = null;
        copperRingInventoryView.setVisibility(View.GONE);
        copperRingDetailScrollView.setVisibility(View.GONE);
        copperRingArtworkView.setVisibility(View.GONE);
        copperRingRetryView.setVisibility(View.GONE);
        panelTitleView.setVisibility(View.VISIBLE);
        panelBodyView.setVisibility(View.VISIBLE);
        panelTitleView.setText("Rings");
        panelBodyView.setText("Loading Silver inventory...");
        if (alphaSilverInventory != null && alphaStarterInventory != null &&
                alphaRingEquipment != null) renderAlphaSilverInventory();
        alphaScreenIo.execute(() -> {
            SilverInventorySnapshot result = null;
            AlphaStarterSnapshot starter = null;
            AlphaRingEquipmentSnapshot equipment = null;
            Future<AlphaStarterSnapshot> starterRead = alphaAssetReadIo.submit(() ->
                    (AlphaStarterSnapshot) Class.forName(
                            "xyz.etherings.player.alpha.AlphaStarterClient")
                            .getMethod("load", android.content.Context.class).invoke(null, this));
            Future<SilverInventorySnapshot> silverRead = alphaAssetReadIo.submit(() ->
                    (SilverInventorySnapshot) Class.forName(
                            "xyz.etherings.player.alpha.AlphaSilverInventoryClient")
                            .getMethod("load", android.content.Context.class).invoke(null, this));
            Future<AlphaRingEquipmentSnapshot> equipmentRead = alphaAssetReadIo.submit(() ->
                    (AlphaRingEquipmentSnapshot) Class.forName(
                            "xyz.etherings.player.alpha.AlphaRingEquipmentClient")
                            .getMethod("load", android.content.Context.class).invoke(null, this));
            try {
                starter = starterRead.get();
                if ("awaiting_wallet".equals(starter.silverStatus())) {
                    result = SilverInventorySnapshot.empty();
                } else {
                    result = silverRead.get();
                }
                equipment = equipmentRead.get();
            } catch (Exception ignored) { }
            SilverInventorySnapshot snapshot = result;
            AlphaStarterSnapshot starterSnapshot = starter;
            AlphaRingEquipmentSnapshot equipmentSnapshot = equipment;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || selectedMode != Mode.RINGS ||
                        request != alphaSilverGeneration) return;
                if (snapshot == null || starterSnapshot == null || equipmentSnapshot == null) {
                    alphaInventoryRefreshing = false;
                    alphaSilverInventory = null;
                    alphaStarterInventory = null;
                    alphaRingEquipment = null;
                    copperRingInventoryView.setVisibility(View.GONE);
                    panelBodyView.setVisibility(View.VISIBLE);
                    panelBodyView.setText("Alpha inventory unavailable. No unverified assets are shown.");
                    copperRingRetryView.setText("Retry inventory");
                    copperRingRetryView.setOnClickListener(view -> loadAlphaSilverInventory());
                    copperRingRetryView.setVisibility(View.VISIBLE);
                    return;
                }
                alphaSilverArtwork = matchingSilverArtwork(alphaSilverInventory, snapshot,
                        alphaSilverArtwork);
                alphaSilverInventory = snapshot;
                alphaStarterInventory = starterSnapshot;
                alphaRingEquipment = equipmentSnapshot;
                alphaInventoryRefreshing = false;
                if (reopenCooper && starterSnapshot.findCooper(reopenCooperId) != null) {
                    alphaCooperDetail = true;
                    alphaCooperDetailId = reopenCooperId;
                }
                if (alphaOpenEquippedDetailOnLoad) {
                    alphaCooperDetail = "COOPER".equals(equipmentSnapshot.selection.kind);
                    alphaCooperDetailId = alphaCooperDetail ?
                            equipmentSnapshot.selection.id : null;
                    alphaSilverDetailMint = alphaCooperDetail ? null :
                            equipmentSnapshot.selection.id;
                    alphaOpenEquippedDetailOnLoad = false;
                }
                renderAlphaSilverInventory();
                if (snapshot.assets().isEmpty() &&
                        !"awaiting_wallet".equals(starterSnapshot.silverStatus()) &&
                        alphaStarterPendingPolls < 8) {
                    alphaStarterPendingPolls++;
                    mainHandler.postDelayed(() -> {
                        if (!isFinishing() && !isDestroyed() && selectedMode == Mode.RINGS &&
                                request == alphaSilverGeneration) loadAlphaSilverInventory();
                    }, 8_000);
                }
            });
            if (snapshot != null && starterSnapshot != null) {
                alphaSilverMediaIo.execute(() -> {
                    Map<String, Bitmap> cooperImages = Collections.emptyMap();
                    try {
                        cooperImages = (Map<String, Bitmap>) Class.forName(
                                "xyz.etherings.player.alpha.AlphaCooperArtwork")
                                .getMethod("loadForCollection", android.content.Context.class, List.class)
                                .invoke(null, this, starterSnapshot.coopers());
                    } catch (Exception ignored) { }
                    Map<String, Bitmap> visuals = Collections.emptyMap();
                    try {
                        visuals = (Map<String, Bitmap>) Class.forName(
                                "xyz.etherings.player.alpha.AlphaSilverArtwork")
                                .getMethod("load", android.content.Context.class, SilverInventorySnapshot.class)
                                .invoke(null, this, snapshot);
                    } catch (Exception ignored) { }
                    Map<String, Bitmap> images = visuals;
                    Map<String, Bitmap> loadedCooperImages = cooperImages;
                    runOnUiThread(() -> {
                        if (isFinishing() || isDestroyed() || selectedMode != Mode.RINGS ||
                                request != alphaSilverGeneration) return;
                        alphaSilverArtwork = images;
                        alphaCooperArtwork = loadedCooperImages;
                        renderAlphaSilverInventory();
                    });
                });
            }
        });
    }

    private void renderAlphaSilverInventory() {
        if (alphaSilverInventory == null || alphaStarterInventory == null ||
                alphaRingEquipment == null) return;
        copperRingInventoryView.setVisibility(View.GONE);
        copperRingDetailScrollView.setVisibility(View.GONE);
        copperRingArtworkView.setVisibility(View.GONE);
        copperRingRetryView.setText("Refresh inventory");
        copperRingRetryView.setOnClickListener(view -> loadAlphaSilverInventory());
        copperRingRetryView.setVisibility(View.GONE);
        SilverInventorySnapshot.Asset detail = null;
        for (SilverInventorySnapshot.Asset asset : alphaSilverInventory.assets()) {
            if (asset.mint.equals(alphaSilverDetailMint)) detail = asset;
        }
        if (detail != null) {
            renderAlphaSilverDetail(detail);
            return;
        }
        if (alphaCooperDetail) {
            renderAlphaCooperDetail();
            return;
        }
        alphaSilverDetailMint = null;
        panelTitleView.setVisibility(View.VISIBLE);
        panelTitleView.setText("Ring inventory");
        boolean unknown = !alphaRingEquipment.effectsEnabled;
        boolean pending = alphaSilverInventory.assets().isEmpty() &&
                !"confirmed".equals(alphaStarterInventory.silverStatus());
        panelBodyView.setVisibility(unknown || pending ? View.VISIBLE : View.GONE);
        panelBodyView.setText(unknown ?
                "Selected Silver chain eligibility unknown; gameplay effects disabled" :
                "awaiting_wallet".equals(alphaStarterInventory.silverStatus()) ?
                "Create and bind a wallet to receive the Silver Box" :
                "unknown".equals(alphaStarterInventory.silverStatus()) ?
                "Silver Box status unavailable; Cooper Rings remain available" :
                "Silver Box issuance pending");
        if (alphaInventoryRefreshing) {
            panelBodyView.setText("Checking current ownership; actions available after refresh.");
            panelBodyView.setVisibility(View.VISIBLE);
        }
        copperRingInventoryListView.removeAllViews();
        List<View> cards = new ArrayList<>();
        for (CopperRing ring : alphaStarterInventory.coopers())
            cards.add(alphaStarterCooperCard(ring));
        for (SilverInventorySnapshot.Asset asset : alphaSilverInventory.assets()) {
            cards.add(alphaSilverInventoryCard(asset));
        }
        for (int index = 0; index < cards.size(); index += 2) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.addView(cards.get(index));
            if (index + 1 < cards.size()) {
                row.addView(cards.get(index + 1));
            } else {
                View spacer = new View(this);
                spacer.setLayoutParams(new LinearLayout.LayoutParams(0, dp(1), 1f));
                row.addView(spacer);
            }
            copperRingInventoryListView.addView(row);
        }
        copperRingInventoryView.setVisibility(View.VISIBLE);
    }

    private ImageView alphaStarterCooperCard(CopperRing ring) {
        boolean equipped = alphaRingEquipment.selection.matches("COOPER", ring.id());
        ImageView card = copperRingInventoryCard(ring, equipped, view -> {
            if (alphaInventoryRefreshing) return;
            alphaCooperDetail = true;
            alphaCooperDetailId = ring.id();
            alphaSilverDetailMint = null;
            renderAlphaSilverInventory();
        });
        Bitmap cooperImage = alphaCooperArtwork.get(ring.visualVariantCode());
        if (cooperImage == null) card.setImageResource(R.drawable.copper_ring_placeholder);
        else card.setImageBitmap(cooperImage);
        card.setScaleType(ImageView.ScaleType.FIT_CENTER);
        card.setContentDescription((equipped ? "Equipped" : "Owned") +
                " Cooper Ring, level " + ring.level() + ", view details");
        return card;
    }

    private FrameLayout alphaSilverInventoryCard(SilverInventorySnapshot.Asset asset) {
        FrameLayout card = new FrameLayout(this);
        boolean equipped = !asset.isBox() && alphaRingEquipment.effectsEnabled &&
                alphaRingEquipment.selection.matches("SILVER_RING", asset.mint);
        card.setBackground(new BorderDrawable(equipped ? accentColor : outlineColor,
                dimension(R.dimen.border_standard), dimension(R.dimen.radius_panel),
                elevatedPanelColor));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(150), 1f);
        params.setMargins(dp(4), dp(4), dp(4), dp(4));
        card.setLayoutParams(params);
        Bitmap image = alphaSilverArtwork.get(asset.mint);
        if (image != null) {
            ImageView artwork = new ImageView(this);
            artwork.setImageBitmap(image);
            artwork.setScaleType(ImageView.ScaleType.FIT_CENTER);
            artwork.setPadding(dp(8), dp(8), dp(8), dp(8));
            artwork.setAlpha(asset.isOpening() ? 0.5f : 1f);
            card.addView(artwork, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        } else {
            TextView unavailable = new TextView(this);
            unavailable.setText("Artwork unavailable");
            unavailable.setTextColor(mutedColor);
            unavailable.setGravity(Gravity.CENTER);
            card.addView(unavailable, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        if (asset.isOpening()) {
            TextView pending = new TextView(this);
            pending.setText("OPENING");
            pending.setTextColor(textColor);
            pending.setBackgroundColor(panelColor);
            pending.setPadding(dp(6), dp(4), dp(6), dp(4));
            FrameLayout.LayoutParams label = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
            label.bottomMargin = dp(8);
            card.addView(pending, label);
        }
        if (!asset.isBox() && alphaRingEquipment.selection.matches("SILVER_RING", asset.mint)) {
            TextView selected = new TextView(this);
            selected.setText(alphaRingEquipment.effectsEnabled ? "EQUIPPED" : "UNVERIFIED");
            selected.setTextColor(textColor);
            selected.setBackgroundColor(panelColor);
            selected.setPadding(dp(6), dp(4), dp(6), dp(4));
            FrameLayout.LayoutParams label = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
            label.bottomMargin = dp(8);
            card.addView(selected, label);
        }
        TextView number = new TextView(this);
        number.setText("#" + asset.serial);
        number.setTextColor(textColor);
        number.setBackgroundColor(panelColor);
        number.setPadding(dp(6), dp(4), dp(6), dp(4));
        FrameLayout.LayoutParams numberLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.END);
        numberLayout.setMargins(dp(4), dp(4), dp(4), 0);
        card.addView(number, numberLayout);
        card.setContentDescription((asset.isBox() ?
                (asset.isOpening() ? "Silver Box opening pending, in escrow" : "Silver Box, sealed") :
                "Silver Ring, design " + asset.designId +
                        (alphaRingEquipment.selection.matches("SILVER_RING", asset.mint) ?
                                ", equipped" : "")) + " number " + asset.serial +
                ", " + asset.mint + ", view details");
        card.setClickable(true);
        card.setFocusable(true);
        card.setOnClickListener(view -> {
            if (alphaInventoryRefreshing) return;
            alphaCooperDetail = false;
            alphaSilverDetailMint = asset.mint;
            renderAlphaSilverInventory();
        });
        return card;
    }

    private Map<String, Bitmap> matchingSilverArtwork(SilverInventorySnapshot previous,
            SilverInventorySnapshot current, Map<String, Bitmap> artwork) {
        if (previous == null || current == null || artwork.isEmpty()) return Collections.emptyMap();
        Map<String, Bitmap> retained = new HashMap<>();
        for (SilverInventorySnapshot.Asset asset : current.assets()) {
            for (SilverInventorySnapshot.Asset old : previous.assets()) {
                if (asset.mint.equals(old.mint) && java.util.Objects.equals(asset.uri, old.uri) &&
                        java.util.Objects.equals(asset.contentHash, old.contentHash) &&
                        artwork.containsKey(asset.mint))
                    retained.put(asset.mint, artwork.get(asset.mint));
            }
        }
        return retained;
    }

    private Map<String, Bitmap> matchingMarketplaceArtwork(
            List<SilverInventorySnapshot.Asset> previous,
            List<SilverInventorySnapshot.Asset> current, Map<String, Bitmap> artwork) {
        if (previous == null || artwork.isEmpty()) return Collections.emptyMap();
        Map<String, Bitmap> retained = new HashMap<>();
        for (SilverInventorySnapshot.Asset asset : current) {
            for (SilverInventorySnapshot.Asset old : previous) {
                if (asset.mint.equals(old.mint) && java.util.Objects.equals(asset.uri, old.uri) &&
                        java.util.Objects.equals(asset.contentHash, old.contentHash) &&
                        artwork.containsKey(asset.mint))
                    retained.put(asset.mint, artwork.get(asset.mint));
            }
        }
        return retained;
    }

    private void renderAlphaSilverDetail(SilverInventorySnapshot.Asset asset) {
        if (!asset.isBox()) ensureAlphaSilverDraft(asset);
        panelTitleView.setVisibility(View.GONE);
        panelBodyView.setVisibility(View.GONE);
        copperRingDetailMetricsView.removeAllViews();
        Bitmap detailArtwork = alphaSilverArtwork.get(asset.mint);
        if (detailArtwork != null) {
            copperRingArtworkView.setImageBitmap(detailArtwork);
            copperRingArtworkView.setScaleType(ImageView.ScaleType.FIT_CENTER);
            copperRingArtworkView.setContentDescription(asset.isBox() ?
                    "Verified Silver Box artwork" :
                    "Verified Silver Ring artwork");
            copperRingArtworkView.setOnClickListener(null);
            copperRingArtworkView.setVisibility(View.VISIBLE);
        } else {
            copperRingArtworkView.setVisibility(View.GONE);
            copperRingDetailMetricsView.addView(metricText("Artwork", "Unavailable"));
        }
        copperRingDetailMetricsView.addView(detailMetricPairRow("Rarity",
                asset.isBox() ? "Silver Box" : "Silver", "NFT #", "#" + asset.serial));
        if (!asset.isBox()) {
            boolean equipped = alphaRingEquipment.selection.matches("SILVER_RING", asset.mint);
            copperRingDetailMetricsView.addView(detailMetricPairRow("Level",
                    String.valueOf(asset.level), "Shine", asset.shine + "%"));
            copperRingDetailMetricsView.addView(detailAttributePairRow(asset,
                    "Comfort", asset.comfort, 0, "Charm", asset.charm, 1));
            copperRingDetailMetricsView.addView(detailAttributePairRow(asset,
                    "Quality", asset.quality, 2, "Luck", asset.luck, 3));
            copperRingDetailMetricsView.addView(detailMetricPairRow("Points",
                    String.valueOf(asset.unspentPoints), "Design", String.valueOf(asset.designId)));
            if (silverDraftTotal() > 0)
                copperRingDetailMetricsView.addView(silverDraftActions(asset));
            if (equipped && !alphaRingEquipment.effectsEnabled)
                copperRingDetailMetricsView.addView(metricText("Equipment",
                        "Chain unverified; gameplay effects disabled"));
            copperRingDetailMetricsView.addView(alphaRingActionRow("SILVER_RING", asset.mint,
                    equipped));
        } else {
            copperRingDetailMetricsView.addView(metricText("State", asset.isOpening() ?
                    "Box in escrow" : "Sealed"));
        }
        TextView identity = metricText("Mint", asset.mint);
        identity.setSingleLine(false);
        copperRingDetailMetricsView.addView(identity);
        if (!asset.isOpening()) {
            TextView send = outlineButton("SEND");
            send.setOnClickListener(view -> {
                try {
                    Class.forName("xyz.etherings.player.alpha.AlphaSilverDirectTransferUi")
                            .getMethod("show", android.app.Activity.class, String.class,
                                    String.class, Runnable.class)
                            .invoke(null, this, asset.mint,
                                    asset.isBox() ? "SILVER_BOX" : "SILVER_RING",
                                    (Runnable) () -> {
                                        loadAlphaSilverInventory();
                                        loadAlphaEconomy();
                                    });
                } catch (Exception error) {
                    showCopperLevelMessage("Silver Send unavailable", error.getMessage());
                }
            });
            copperRingDetailMetricsView.addView(send);
        }
        if (asset.isBox() && !asset.isOpening()) {
            TextView sell = outlineButton("SELL / LISTING");
            sell.setOnClickListener(view -> {
                selectMode(Mode.MARKETPLACE);
                showAlphaMarketplaceAsset(asset);
            });
            copperRingDetailMetricsView.addView(sell);
        }
        if (!asset.isBox() && "confirmed".equals(asset.openingStatus)) {
            TextView result = metricText("Opening", "Complete. Source Box burned.");
            copperRingDetailMetricsView.addView(result);
            TextView sourceBox = metricText("Source Box", asset.boxMint);
            sourceBox.setSingleLine(false);
            copperRingDetailMetricsView.addView(sourceBox);
        }
        if (asset.isBox()) {
            TextView opening = metricText("Opening", "Checking opening readiness...");
            opening.setSingleLine(false);
            copperRingDetailMetricsView.addView(opening);
            TextView review = outlineButton("Review opening");
            review.setVisibility(View.GONE);
            copperRingDetailMetricsView.addView(review);
            TextView sign = outlineButton("Sign opening");
            sign.setVisibility(View.GONE);
            copperRingDetailMetricsView.addView(sign);
            if (asset.isOpening()) {
                opening.setText("Opening is not complete. The Box remains in program escrow; " +
                        "no Ring has been minted from this Box. Finalization must burn the Box " +
                        "and mint its Ring atomically.");
            } else if (new BigInteger(asset.cooldownUntilUnixSeconds).compareTo(
                    BigInteger.valueOf(System.currentTimeMillis() / 1000)) <= 0) {
                checkAlphaSilverOpening(asset, opening, review, sign);
            } else {
                opening.setText("Opening unavailable until cooldown expires.");
            }
        }
        copperRingDetailScrollView.setVisibility(View.VISIBLE);
    }

    private void renderAlphaCooperDetail() {
        CopperRing ring = alphaStarterInventory.findCooper(alphaCooperDetailId);
        if (ring == null) {
            alphaCooperDetail = false;
            alphaCooperDetailId = null;
            renderAlphaSilverInventory();
            return;
        }
        ensureCopperAttributeDraft(ring);
        panelTitleView.setVisibility(View.GONE);
        panelBodyView.setVisibility(View.GONE);
        Bitmap cooperImage = alphaCooperArtwork.get(ring.visualVariantCode());
        if (cooperImage == null)
            copperRingArtworkView.setImageResource(R.drawable.copper_ring_placeholder);
        else copperRingArtworkView.setImageBitmap(cooperImage);
        copperRingArtworkView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        copperRingArtworkView.setContentDescription("Cooper Ring, level " + ring.level());
        copperRingArtworkView.setOnClickListener(null);
        copperRingArtworkView.setVisibility(View.VISIBLE);
        copperRingDetailMetricsView.removeAllViews();
        copperRingDetailMetricsView.addView(detailMetricPairRow(
                "Rarity", "Cooper", "Level", String.valueOf(ring.level())));
        copperRingDetailMetricsView.addView(detailAttributePairRow(
                ring, "Comfort", ring.comfort(), 0, "Charm", ring.charm(), 1));
        copperRingDetailMetricsView.addView(detailAttributePairRow(
                ring, "Quality", ring.quality(), 2, "Luck", ring.luck(), 3));
        copperRingDetailMetricsView.addView(detailMetricPairRow("Points",
                String.valueOf(ring.unspentAttributePoints()), "Shine", ring.shine() + "%"));
        if (copperAttributeDraft.total() > 0)
            copperRingDetailMetricsView.addView(copperAttributeDraftActions(ring));
        boolean equipped = alphaRingEquipment.selection.matches("COOPER", ring.id());
        copperRingDetailMetricsView.addView(alphaRingActionRow("COOPER", ring.id(), equipped));
        copperRingDetailScrollView.setVisibility(View.VISIBLE);
    }

    private LinearLayout alphaRingActionRow(String kind, String id, boolean equipped) {
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        actions.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        SilverInventorySnapshot.Asset silver = null;
        if ("SILVER_RING".equals(kind) && alphaSilverInventory != null)
            for (SilverInventorySnapshot.Asset candidate : alphaSilverInventory.assets())
                if (id.equals(candidate.mint)) { silver = candidate; break; }
        final SilverInventorySnapshot.Asset selectedSilver = silver;
        final CopperRing selectedCooper = "COOPER".equals(kind) &&
                alphaStarterInventory != null ? alphaStarterInventory.findCooper(id) : null;
        boolean cooperReady = "COOPER".equals(kind) && !alphaCooperProgressInFlight &&
                !alphaEquipInFlight && selectedCooper != null && selectedCooper.level() < 20;
        boolean silverReady = selectedSilver != null && !alphaSilverProgressInFlight &&
                !alphaEquipInFlight && selectedSilver.level >= 1 && selectedSilver.level < 20;
        FrameLayout level = compactRingActionSlot("LVLUP", cooperReady || silverReady);
        level.setOnClickListener(view -> {
            if (selectedSilver != null) beginAlphaSilverLevelUp(selectedSilver);
            else if (selectedCooper != null) beginAlphaCooperLevelUp(selectedCooper);
        });
        actions.addView(level);
        FrameLayout equip = compactRingActionSlot("EQUIP", !equipped && !alphaEquipInFlight);
        equip.setOnClickListener(view -> beginAlphaEquip(kind, id));
        actions.addView(equip);
        FrameLayout mint = compactRingActionSlot("MINT", selectedCooper != null &&
                selectedCooper.level() == 20 && !alphaCooperProgressInFlight);
        mint.setOnClickListener(view -> {
            if (selectedCooper != null) showAlphaBreedingDialog(selectedCooper);
        });
        actions.addView(mint);
        FrameLayout sell = compactRingActionSlot("SELL", selectedSilver != null);
        sell.setOnClickListener(view -> {
            if (selectedSilver == null) return;
            selectMode(Mode.MARKETPLACE);
            showAlphaMarketplaceAsset(selectedSilver);
        });
        actions.addView(sell);
        return actions;
    }

    private JSONObject alphaCooperCall(String method, Class<?>[] types, Object... args) throws Exception {
        try {
            return (JSONObject) Class.forName(
                    "xyz.etherings.player.alpha.AlphaCooperProgressionClient")
                    .getMethod(method, types).invoke(null, args);
        } catch (java.lang.reflect.InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw error;
        }
    }

    private JSONObject alphaBreedingCall(String method, Class<?>[] types, Object... args)
            throws Exception {
        try {
            return (JSONObject) Class.forName(
                    "xyz.etherings.player.alpha.AlphaCooperBreedingClient")
                    .getMethod(method, types).invoke(null, args);
        } catch (java.lang.reflect.InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw error;
        }
    }

    private ImageView breedingCooperArtwork(CopperRing ring) {
        ImageView artwork = new ImageView(this);
        Bitmap image = ring == null ? null : alphaCooperArtwork.get(ring.visualVariantCode());
        if (image != null) artwork.setImageBitmap(image);
        else artwork.setImageResource(ring == null ? R.drawable.copper_ring_placeholder :
                CopperRingVisualCatalog.drawableFor(ring.visualVariantCode()));
        artwork.setScaleType(ImageView.ScaleType.FIT_CENTER);
        artwork.setContentDescription(ring == null ? "Select second Cooper Ring" :
                "Cooper Ring, level " + ring.level());
        return artwork;
    }

    private LinearLayout breedingCooperCell(CopperRing ring, String label) {
        LinearLayout cell = new LinearLayout(this);
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.CENTER);
        cell.setPadding(dp(6), dp(6), dp(6), dp(6));
        cell.setBackground(new BorderDrawable(outlineColor,
                dimension(R.dimen.border_standard), dimension(R.dimen.radius_panel),
                elevatedPanelColor));
        cell.addView(breedingCooperArtwork(ring), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(110)));
        TextView caption = new TextView(this);
        caption.setText(label);
        caption.setTextColor(accentColor);
        caption.setTextSize(12);
        caption.setGravity(Gravity.CENTER);
        cell.addView(caption);
        return cell;
    }

    private boolean sameBreedingAmount(JSONObject preview, JSONObject review, String field) {
        String shown = preview.optString(field, "");
        String approved = review.optString(field, "");
        if (!shown.matches("[0-9]+(?:\\.[0-9]+)?") ||
                !approved.matches("[0-9]+(?:\\.[0-9]+)?")) return false;
        return new BigDecimal(shown).compareTo(new BigDecimal(approved)) == 0;
    }

    private void showAlphaBreedingDialog(CopperRing first) {
        if (alphaCooperProgressInFlight || first.level() != 20 || alphaStarterInventory == null)
            return;
        List<CopperRing> choices = new ArrayList<>();
        for (CopperRing candidate : alphaStarterInventory.coopers())
            if (!candidate.id().equals(first.id())) choices.add(candidate);
        if (choices.isEmpty()) {
            showCopperLevelMessage("Breeding unavailable", "A second owned Cooper Ring is required.");
            return;
        }
        LinearLayout surface = new LinearLayout(this);
        surface.setOrientation(LinearLayout.VERTICAL);
        surface.setPadding(dp(18), dp(18), dp(18), dp(10));
        surface.setBackgroundColor(panelColor);
        LinearLayout parents = new LinearLayout(this);
        parents.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout firstCell = breedingCooperCell(first, "Cooper L" + first.level());
        parents.addView(firstCell, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView plus = new TextView(this);
        plus.setText("+");
        plus.setTextColor(accentColor);
        plus.setTextSize(24);
        parents.addView(plus);
        LinearLayout secondCell = breedingCooperCell(null, "Select Cooper");
        parents.addView(secondCell, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        surface.addView(parents);
        TextView price = new TextView(this);
        price.setText("Select a second Ring to see the exact price.");
        price.setTextColor(textColor);
        price.setPadding(0, dp(18), 0, dp(8));
        surface.addView(price);
        CopperRing[] selected = { null };
        JSONObject[] preview = { null };
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Cooper breeding")
                .setView(surface).setNegativeButton("Cancel", null)
                .setPositiveButton("BREEDING", null).create();
        dialog.setOnShowListener(ignored -> {
            Button breeding = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            breeding.setEnabled(false);
            breeding.setOnClickListener(view -> {
                if (selected[0] == null || preview[0] == null) return;
                dialog.dismiss();
                prepareAlphaBreeding(first, selected[0], preview[0]);
            });
            secondCell.setOnClickListener(view -> {
                LinearLayout grid = new LinearLayout(this);
                grid.setOrientation(LinearLayout.VERTICAL);
                grid.setPadding(dp(8), dp(8), dp(8), dp(8));
                ScrollView scroll = new ScrollView(this);
                scroll.addView(grid);
                AlertDialog picker = new AlertDialog.Builder(this)
                        .setTitle("Second Cooper Ring").setView(scroll)
                        .setNegativeButton("Cancel", null).create();
                for (int index = 0; index < choices.size(); index += 2) {
                    LinearLayout row = new LinearLayout(this);
                    row.setOrientation(LinearLayout.HORIZONTAL);
                    grid.addView(row);
                    for (int column = 0; column < 2 && index + column < choices.size(); column++) {
                        CopperRing choice = choices.get(index + column);
                        LinearLayout card = breedingCooperCell(choice,
                                "Cooper L" + choice.level());
                        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                        cardParams.setMargins(dp(4), dp(4), dp(4), dp(4));
                        row.addView(card, cardParams);
                        card.setContentDescription("Select Cooper Ring, level " +
                                choice.level());
                        card.setOnClickListener(chosen -> {
                            picker.dismiss();
                            selected[0] = choice;
                            preview[0] = null;
                            breeding.setEnabled(false);
                            secondCell.removeViewAt(0);
                            secondCell.addView(breedingCooperArtwork(choice), 0,
                                    new LinearLayout.LayoutParams(
                                            ViewGroup.LayoutParams.MATCH_PARENT, dp(110)));
                            ((TextView) secondCell.getChildAt(1)).setText(
                                    "Cooper L" + choice.level());
                            price.setText("Checking eligibility and exact price…");
                            CopperRing target = choice;
                            alphaSilverIo.execute(() -> {
                                JSONObject result = null;
                                String failure = null;
                                try { result = alphaBreedingCall("preview", new Class<?>[] {
                                        android.content.Context.class, String.class, String.class },
                                        this, first.id(), target.id()); }
                                catch (Exception error) { failure = error.getMessage(); }
                                JSONObject confirmed = result;
                                String problem = failure;
                                runOnUiThread(() -> {
                                    if (!dialog.isShowing() || selected[0] != target) return;
                                    if (confirmed == null) {
                                        price.setText(problem == null ?
                                                "Breeding unavailable" : problem);
                                        return;
                                    }
                                    JSONObject cost = confirmed.optJSONObject("cost");
                                    if (cost == null) return;
                                    preview[0] = confirmed;
                                    price.setText(cost.optString("ertExact") + " ERT + " +
                                            cost.optString("eruPrincipalExact") + " ERU + " +
                                            cost.optString("eruFeeExact") +
                                            " ERU fee\nOne Silver Box; parents retained.");
                                    breeding.setEnabled(true);
                                });
                            });
                        });
                    }
                }
                picker.show();
            });
        });
        dialog.show();
    }

    private void prepareAlphaBreeding(CopperRing first, CopperRing second, JSONObject preview) {
        if (alphaCooperProgressInFlight) return;
        String key = pendingAlphaBreeding.keyFor(first.id() + ":" + second.id());
        alphaCooperProgressInFlight = true;
        renderAlphaCooperDetail();
        alphaSilverIo.execute(() -> {
            JSONObject prepared = null, review = null;
            String failure = null;
            try {
                prepared = alphaBreedingCall("prepare", new Class<?>[] {
                        android.content.Context.class, String.class, String.class, String.class },
                        this, first.id(), second.id(), key);
                review = alphaBreedingCall("review", new Class<?>[] {
                        android.content.Context.class, String.class },
                        this, prepared.getString("operationId"));
            } catch (Exception error) { failure = error.getMessage(); }
            JSONObject reservation = prepared;
            JSONObject approved = review;
            String problem = failure;
            runOnUiThread(() -> {
                alphaCooperProgressInFlight = false;
                if (!alphaCooperDetail || selectedMode != Mode.RINGS) return;
                renderAlphaCooperDetail();
                if (approved == null) {
                    showCopperLevelMessage("Breeding review unavailable", problem); return;
                }
                JSONObject cost = approved.optJSONObject("terms");
                JSONObject previewCost = preview.optJSONObject("cost");
                if (cost == null || previewCost == null ||
                        !sameBreedingAmount(previewCost, cost, "ertExact") ||
                        !sameBreedingAmount(previewCost, cost, "eruPrincipalExact") ||
                        !sameBreedingAmount(previewCost, cost, "eruFeeExact")) {
                    showCopperLevelMessage("Breeding review changed",
                            "Reopen the dialog to review the authoritative price.");
                    return;
                }
                LinearLayout confirmation = new LinearLayout(this);
                confirmation.setOrientation(LinearLayout.VERTICAL);
                confirmation.setPadding(dp(18), dp(18), dp(18), dp(12));
                LinearLayout parents = new LinearLayout(this);
                parents.setGravity(Gravity.CENTER_VERTICAL);
                parents.addView(breedingCooperCell(first, "Cooper L" + first.level()),
                        new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                TextView plus = new TextView(this);
                plus.setText("+");
                plus.setTextColor(accentColor);
                plus.setTextSize(24);
                parents.addView(plus);
                parents.addView(breedingCooperCell(second, "Cooper L" + second.level()),
                        new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                confirmation.addView(parents);
                TextView terms = new TextView(this);
                terms.setText("Pay: " + previewCost.optString("ertExact") + " ERT + " +
                        previewCost.optString("eruPrincipalExact") + " ERU + " +
                        previewCost.optString("eruFeeExact") +
                        " ERU fee\nResult: one Silver Box. Parents remain.");
                terms.setTextColor(textColor);
                terms.setPadding(0, dp(18), 0, dp(8));
                confirmation.addView(terms);
                new AlertDialog.Builder(this).setTitle("Confirm breeding on Devnet")
                        .setView(confirmation)
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton("Sign and submit", (ignored, which) ->
                                submitAlphaBreeding(first, second,
                                        reservation.optString("operationId"), approved))
                        .show();
            });
        });
    }

    private void submitAlphaBreeding(CopperRing first, CopperRing second,
            String operationId, JSONObject approved) {
        if (alphaCooperProgressInFlight) return;
        alphaCooperProgressInFlight = true;
        renderAlphaCooperDetail();
        alphaSilverIo.execute(() -> {
            String outcome = "unknown", failure = null;
            try {
                JSONObject refreshed = alphaBreedingCall("refresh", new Class<?>[] {
                        android.content.Context.class, String.class, JSONObject.class },
                        this, operationId, approved);
                byte[] signature = (byte[]) Class.forName(
                        "xyz.etherings.player.alpha.AlphaCooperBreedingClient")
                        .getMethod("signReviewed", android.content.Context.class,
                                JSONObject.class, JSONObject.class, String.class, String.class)
                        .invoke(null, this, approved, refreshed, first.id(), second.id());
                alphaBreedingCall("submit", new Class<?>[] { android.content.Context.class,
                        String.class, JSONObject.class, byte[].class },
                        this, operationId, refreshed, signature);
                for (int attempt = 0; attempt < 20; attempt++) {
                    JSONObject status = alphaBreedingCall("status", new Class<?>[] {
                            android.content.Context.class, String.class }, this, operationId);
                    outcome = status.optString("status", "unknown");
                    if ("confirmed".equals(outcome)) break;
                    Thread.sleep(1000);
                }
            } catch (Exception error) { failure = error.getMessage(); }
            String finalOutcome = outcome, problem = failure;
            runOnUiThread(() -> {
                alphaCooperProgressInFlight = false;
                if ("confirmed".equals(finalOutcome)) {
                    pendingAlphaBreeding.clear();
                    showCopperLevelMessage("Breeding complete", "Silver Box added to Rings.");
                    loadAlphaSilverInventory();
                    loadAlphaEconomy();
                } else {
                    showCopperLevelMessage("Breeding not yet confirmed", problem == null ?
                            "Status is UNKNOWN. Do not sign a new operation; refresh inventory." :
                            problem);
                    if (alphaCooperDetail) renderAlphaCooperDetail();
                }
            });
        });
    }

    private JSONObject alphaSilverProgressionCall(String method, Class<?>[] types,
            Object... args) throws Exception {
        try {
            return (JSONObject) Class.forName(
                    "xyz.etherings.player.alpha.AlphaSilverProgressionClient")
                    .getMethod(method, types).invoke(null, args);
        } catch (java.lang.reflect.InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw error;
        }
    }

    private JSONObject alphaMarketplaceCall(String method, Class<?>[] types,
            Object... args) throws Exception {
        try {
            return (JSONObject) Class.forName(
                    "xyz.etherings.player.alpha.AlphaMarketplaceClient")
                    .getMethod(method, types).invoke(null, args);
        } catch (java.lang.reflect.InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw error;
        }
    }

    private String alphaMarketplaceWallet() throws Exception {
        try {
            return (String) Class.forName(
                    "xyz.etherings.player.alpha.AlphaMarketplaceClient")
                    .getMethod("boundWallet", android.content.Context.class).invoke(null, this);
        } catch (java.lang.reflect.InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw error;
        }
    }

    private static String alphaMarketSol(String lamports) {
        return new java.math.BigDecimal(new BigInteger(lamports))
                .movePointLeft(9).stripTrailingZeros().toPlainString() + " SOL";
    }

    private void renderAlphaMarketplaceSection() {
        alphaMarketplaceListView.removeAllViews();
        LinearLayout tabs = new LinearLayout(this);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        alphaMarketplaceBrowseTab = modeTab("Browse", Mode.MARKETPLACE, false);
        alphaMarketplaceBrowseTab.setId(R.id.marketplace_browse);
        alphaMarketplaceMineTab = modeTab("My Listings", Mode.MARKETPLACE, false);
        alphaMarketplaceMineTab.setId(R.id.marketplace_my_listings);
        alphaMarketplaceBrowseTab.setOnClickListener(view -> selectAlphaMarketplaceSection(false));
        alphaMarketplaceMineTab.setOnClickListener(view -> selectAlphaMarketplaceSection(true));
        tabs.addView(alphaMarketplaceBrowseTab);
        tabs.addView(alphaMarketplaceMineTab);
        alphaMarketplaceListView.addView(tabs);
        applyTabState(alphaMarketplaceBrowseTab, !alphaMarketplaceMyListings, false);
        applyTabState(alphaMarketplaceMineTab, alphaMarketplaceMyListings, false);
        TextView refresh = outlineButton("Refresh listings");
        refresh.setOnClickListener(view -> loadAlphaMarketplaceListings());
        alphaMarketplaceListView.addView(refresh);
        loadAlphaMarketplaceListings();
    }

    private void selectAlphaMarketplaceSection(boolean mine) {
        if (alphaMarketplaceMyListings == mine) return;
        alphaMarketplaceMyListings = mine;
        applyTabState(alphaMarketplaceBrowseTab, !mine, false);
        applyTabState(alphaMarketplaceMineTab, mine, false);
        loadAlphaMarketplaceListings();
    }

    private void loadAlphaMarketplaceListings() {
        int request = ++alphaMarketplaceGeneration;
        boolean mine = alphaMarketplaceMyListings;
        alphaMarketplaceRefreshing = true;
        while (alphaMarketplaceListView.getChildCount() > 2)
            alphaMarketplaceListView.removeViewAt(2);
        String email = getIntent().getStringExtra(ALPHA_VERIFIED_EMAIL);
        if (alphaMarketplaceLastListings != null && alphaMarketplaceLastMine == mine &&
                java.util.Objects.equals(alphaMarketplaceLastEmail, email))
            renderAlphaMarketplaceCards(alphaMarketplaceLastListings, alphaMarketplaceLastAssets,
                    alphaMarketplaceLastWallet, mine);
        else alphaMarketplaceListView.addView(metricText("Status", "Loading listings..."));
        alphaScreenIo.execute(() -> {
            try {
                String wallet;
                try { wallet = alphaMarketplaceWallet(); }
                catch (Exception noBoundWallet) { wallet = null; }
                JSONObject response = alphaMarketplaceCall("listings",
                        new Class<?>[] { android.content.Context.class }, this);
                org.json.JSONArray listings = response.getJSONArray("listings");
                List<JSONObject> visible = new ArrayList<>();
                List<SilverInventorySnapshot.Asset> assets = new ArrayList<>();
                for (int i = 0; i < listings.length(); i++) {
                    JSONObject listing = listings.getJSONObject(i);
                    if (mine && !listing.getString("sellerAddress").equals(wallet)) continue;
                    SilverInventorySnapshot.Asset asset = SilverInventorySnapshot.parse(
                            new JSONObject().put("assets", new org.json.JSONArray()
                                    .put(listing.getJSONObject("asset")))).assets().get(0);
                    if (!asset.mint.equals(listing.getString("mintAddress")) ||
                            !asset.kind.equals(listing.getString("kind")))
                        throw new IllegalArgumentException("Marketplace asset mismatch");
                    visible.add(listing);
                    assets.add(asset);
                }
                String boundWallet = wallet;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || selectedMode != Mode.MARKETPLACE ||
                            request != alphaMarketplaceGeneration) return;
                    alphaMarketplaceArtwork = matchingMarketplaceArtwork(alphaMarketplaceLastAssets,
                            assets, alphaMarketplaceArtwork);
                    alphaMarketplaceLastListings = visible;
                    alphaMarketplaceLastAssets = assets;
                    alphaMarketplaceLastWallet = boundWallet;
                    alphaMarketplaceLastEmail = email;
                    alphaMarketplaceLastMine = mine;
                    alphaMarketplaceRefreshing = false;
                    renderAlphaMarketplaceCards(visible, assets, boundWallet, mine);
                });
                alphaSilverMediaIo.execute(() -> {
                    Map<String, Bitmap> images = new HashMap<>();
                    for (SilverInventorySnapshot.Asset asset : assets) {
                        try {
                            Bitmap image = (Bitmap) Class.forName(
                                    "xyz.etherings.player.alpha.AlphaSilverArtwork")
                                    .getMethod("loadOne", android.content.Context.class,
                                            String.class, String.class)
                                    .invoke(null, this, asset.uri, asset.contentHash);
                            if (image != null) images.put(asset.mint, image);
                        } catch (Exception ignored) { }
                    }
                    runOnUiThread(() -> {
                        if (isFinishing() || isDestroyed() || selectedMode != Mode.MARKETPLACE ||
                                request != alphaMarketplaceGeneration) return;
                        alphaMarketplaceArtwork = images;
                        renderAlphaMarketplaceCards(visible, assets, boundWallet, mine);
                    });
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || selectedMode != Mode.MARKETPLACE ||
                            request != alphaMarketplaceGeneration) return;
                    alphaMarketplaceRefreshing = false;
                    alphaMarketplaceLastListings = null;
                    alphaMarketplaceLastAssets = null;
                    alphaMarketplaceArtwork = Collections.emptyMap();
                    while (alphaMarketplaceListView.getChildCount() > 2)
                        alphaMarketplaceListView.removeViewAt(2);
                    alphaMarketplaceListView.addView(metricText("Status", mine ?
                            "My Listings unavailable. Check your bound wallet and retry." :
                            "Marketplace unavailable. Retry listings."));
                });
            }
        });
    }

    private void renderAlphaMarketplaceCards(List<JSONObject> listings,
            List<SilverInventorySnapshot.Asset> assets, String wallet, boolean mine) {
        while (alphaMarketplaceListView.getChildCount() > 2)
            alphaMarketplaceListView.removeViewAt(2);
        if (alphaMarketplaceRefreshing)
            alphaMarketplaceListView.addView(metricText("Status",
                    "Checking current listings; actions available after refresh."));
        if (listings.isEmpty()) {
            alphaMarketplaceListView.addView(metricText("Status", mine ?
                    "You have no active listings." :
                    "No Silver Rings or sealed Boxes listed yet."));
            return;
        }
        for (int index = 0; index < listings.size(); index += 2) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (int column = index; column < Math.min(index + 2, listings.size()); column++) {
                JSONObject listing = listings.get(column);
                SilverInventorySnapshot.Asset asset = assets.get(column);
                boolean owner = listing.optString("sellerAddress").equals(wallet);
                LinearLayout card = new LinearLayout(this);
                card.setOrientation(LinearLayout.VERTICAL);
                card.setBackground(new BorderDrawable(outlineColor,
                        dimension(R.dimen.border_standard), dimension(R.dimen.radius_panel),
                        elevatedPanelColor));
                LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                        0, dp(200), 1f);
                cardParams.setMargins(dp(4), dp(4), dp(4), dp(4));
                card.setLayoutParams(cardParams);
                Bitmap image = alphaMarketplaceArtwork.get(asset.mint);
                if (image != null) {
                    ImageView artwork = new ImageView(this);
                    artwork.setImageBitmap(image);
                    artwork.setScaleType(ImageView.ScaleType.FIT_CENTER);
                    artwork.setPadding(dp(8), dp(8), dp(8), dp(8));
                    card.addView(artwork, new LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
                } else {
                    TextView pending = new TextView(this);
                    pending.setText("Artwork loading...");
                    pending.setTextColor(mutedColor);
                    pending.setGravity(Gravity.CENTER);
                    card.addView(pending, new LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
                }
                TextView caption = metricText(asset.isBox() ? "Silver Box #" + asset.serial :
                        "Silver Ring #" + asset.serial,
                        alphaMarketSol(listing.optString("priceLamports")));
                caption.setGravity(Gravity.CENTER);
                card.addView(caption);
                card.setContentDescription((asset.isBox() ? "Silver Box" : "Silver Ring") +
                        " number " + asset.serial + ", price " +
                        alphaMarketSol(listing.optString("priceLamports")) + ", view details");
                card.setClickable(true);
                card.setFocusable(true);
                card.setOnClickListener(view -> {
                    if (alphaMarketplaceRefreshing) return;
                    showAlphaMarketplaceDetail(listing, asset, owner);
                });
                row.addView(card);
            }
            if (index + 1 == listings.size()) row.addView(new View(this),
                    new LinearLayout.LayoutParams(0, dp(1), 1f));
            alphaMarketplaceListView.addView(row);
        }
    }

    private void showAlphaMarketplaceDetail(JSONObject listing,
            SilverInventorySnapshot.Asset asset, boolean owner) {
        ScrollView scroll = new ScrollView(this);
        LinearLayout details = new LinearLayout(this);
        details.setOrientation(LinearLayout.VERTICAL);
        details.setPadding(dp(12), dp(12), dp(12), dp(12));
        scroll.addView(details);
        Bitmap image = alphaMarketplaceArtwork.get(asset.mint);
        if (image != null) {
            ImageView artwork = new ImageView(this);
            artwork.setImageBitmap(image);
            artwork.setScaleType(ImageView.ScaleType.FIT_CENTER);
            details.addView(artwork, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(210)));
        } else details.addView(metricText("Artwork", "Unavailable"));
        details.addView(detailMetricPairRow("Rarity", asset.isBox() ? "Silver Box" : "Silver",
                "NFT #", "#" + asset.serial));
        if (!asset.isBox()) {
            details.addView(detailMetricPairRow("Level", String.valueOf(asset.level),
                    "Shine", asset.shine + "%"));
            details.addView(detailMetricPairRow("Comfort", String.valueOf(asset.comfort),
                    "Charm", String.valueOf(asset.charm)));
            details.addView(detailMetricPairRow("Quality", String.valueOf(asset.quality),
                    "Luck", String.valueOf(asset.luck)));
            details.addView(detailMetricPairRow("Points", String.valueOf(asset.unspentPoints),
                    "Design", String.valueOf(asset.designId)));
        } else details.addView(metricText("State", "Sealed"));
        details.addView(metricText("Price", alphaMarketSol(
                listing.optString("priceLamports"))));
        TextView mint = metricText("Mint", asset.mint);
        mint.setSingleLine(false);
        details.addView(mint);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(asset.isBox() ? "Silver Box #" + asset.serial :
                        "Silver Ring #" + asset.serial)
                .setView(scroll).setNegativeButton("Back", null).create();
        TextView action = outlineButton(owner ? "UNLIST" : "BUY");
        action.setOnClickListener(view -> {
            dialog.dismiss();
            startAlphaMarketplace(owner ? "CANCEL" : "BUY", asset.mint, null);
        });
        details.addView(action);
        dialog.show();
        if (dialog.getWindow() != null) dialog.getWindow().setBackgroundDrawable(
                new android.graphics.drawable.ColorDrawable(elevatedPanelColor));
    }

    private void showAlphaMarketplaceAsset(SilverInventorySnapshot.Asset asset) {
        if (alphaMarketplaceInFlight) return;
        alphaSilverIo.execute(() -> {
            try {
                JSONObject listing = alphaMarketplaceCall("listingOrNull",
                        new Class<?>[] { android.content.Context.class, String.class },
                        this, asset.mint);
                String wallet = alphaMarketplaceWallet();
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    try {
                        if (listing != null && "ACTIVE".equals(listing.getString("state"))) {
                            if (!wallet.equals(listing.getString("sellerAddress"))) {
                                showCopperLevelMessage("Listing unavailable",
                                        "A previous seller's listing is still active; " +
                                                "only that seller can cancel it.");
                                return;
                            }
                            new AlertDialog.Builder(this).setTitle("Your Silver listing")
                                    .setMessage("Price: " + alphaMarketSol(
                                            listing.getString("priceLamports")) +
                                            "\nCancel this listing?")
                                    .setNegativeButton("Keep", null)
                                    .setPositiveButton("Cancel listing", (dialog, which) ->
                                            startAlphaMarketplace("CANCEL", asset.mint, null))
                                    .show();
                            return;
                        }
                        EditText price = new EditText(this);
                        price.setHint("Price in SOL (up to 9 decimals)");
                        price.setInputType(InputType.TYPE_CLASS_NUMBER |
                                InputType.TYPE_NUMBER_FLAG_DECIMAL);
                        new AlertDialog.Builder(this).setTitle("List Silver NFT")
                                .setMessage("NFT #" + asset.serial +
                                        " stays in your wallet until sold or cancelled. " +
                                        "Buyer pays your price plus 4% royalty and 2% platform fee.")
                                .setView(price).setNegativeButton("Back", null)
                                .setPositiveButton("Review", (dialog, which) -> {
                                    try {
                                        String value = price.getText().toString().trim();
                                        if (!value.matches("[0-9]+(\\.[0-9]{1,9})?"))
                                            throw new IllegalArgumentException("Enter exact SOL price");
                                        BigInteger lamports = new java.math.BigDecimal(value)
                                                .movePointRight(9).toBigIntegerExact();
                                        if (lamports.signum() <= 0 ||
                                                lamports.bitLength() > 64)
                                            throw new IllegalArgumentException("SOL price out of range");
                                        startAlphaMarketplace("LIST", asset.mint,
                                                lamports.toString());
                                    } catch (Exception error) {
                                        showCopperLevelMessage("Invalid price", error.getMessage());
                                    }
                                }).show();
                    } catch (Exception error) {
                        showCopperLevelMessage("Marketplace unavailable", error.getMessage());
                    }
                });
            } catch (Exception error) {
                runOnUiThread(() -> showCopperLevelMessage("Marketplace unavailable",
                        error.getMessage()));
            }
        });
    }

    private void startAlphaMarketplace(String action, String mint, String priceLamports) {
        if (alphaMarketplaceInFlight) return;
        try {
            JSONObject pending = alphaMarketplaceCall("pending",
                    new Class<?>[] { android.content.Context.class }, this);
            if (pending != null) {
                resumeAlphaMarketplace(pending);
                return;
            }
        } catch (Exception error) {
            showCopperLevelMessage("Marketplace unavailable", error.getMessage());
            return;
        }
        alphaMarketplaceInFlight = true;
        String operationId = pendingAlphaMarketplace.keyFor(
                "MARKET:" + action + ":" + mint + ":" + priceLamports);
        alphaSilverIo.execute(() -> {
            try {
                JSONObject approved = alphaMarketplaceCall("review", new Class<?>[] {
                        android.content.Context.class, String.class, String.class,
                        String.class, String.class }, this, action, mint,
                        priceLamports, operationId);
                JSONObject terms = approved.getJSONObject("terms");
                String message = "NFT: " + terms.getString("kind").replace('_', ' ') +
                        "\nMint: " + mint + "\nListing nonce: " + terms.getString("nonce") +
                        "\nSeller price: " + alphaMarketSol(terms.getString("priceLamports"));
                if (!"CANCEL".equals(action)) message +=
                        "\nRoyalty (4%): " + alphaMarketSol(terms.getString("royaltyLamports")) +
                        "\nPlatform (2%): " + alphaMarketSol(terms.getString("platformLamports")) +
                        "\nBuyer total: " + alphaMarketSol(terms.getString("buyerDebitLamports"));
                String reviewText = message;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) {
                        alphaMarketplaceInFlight = false; return;
                    }
                    new AlertDialog.Builder(this).setTitle(action + " — confirm exact SOL terms")
                            .setMessage(reviewText)
                            .setNegativeButton("Back", (dialog, which) ->
                                    alphaMarketplaceInFlight = false)
                            .setOnCancelListener(dialog -> alphaMarketplaceInFlight = false)
                            .setPositiveButton("Review and sign", (dialog, which) ->
                                    submitAlphaMarketplace(action, mint, operationId, approved))
                            .show();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    alphaMarketplaceInFlight = false;
                    showCopperLevelMessage("LIST".equals(action) ?
                            "Listing unavailable" : "Marketplace review unavailable",
                            error.getMessage());
                });
            }
        });
    }

    private void submitAlphaMarketplace(String action, String mint, String operationId,
            JSONObject approved) {
        alphaSilverIo.execute(() -> {
            String outcome = "unknown", problem = null;
            try {
                JSONObject refreshed = alphaMarketplaceCall("refresh", new Class<?>[] {
                        android.content.Context.class, JSONObject.class }, this, approved);
                byte[] signature = (byte[]) Class.forName(
                        "xyz.etherings.player.alpha.AlphaMarketplaceClient")
                        .getMethod("signReviewed", android.content.Context.class,
                                JSONObject.class, JSONObject.class, String.class, String.class)
                        .invoke(null, this, approved, refreshed, action, mint);
                alphaMarketplaceCall("submit", new Class<?>[] { android.content.Context.class,
                        JSONObject.class, byte[].class }, this, refreshed, signature);
                for (int attempt = 0; attempt < 20; attempt++) {
                    JSONObject status = alphaMarketplaceCall("status", new Class<?>[] {
                            android.content.Context.class, String.class }, this, operationId);
                    outcome = status.optString("status", "unknown");
                    if (!"unknown".equals(outcome)) break;
                    Thread.sleep(1000);
                }
            } catch (Exception error) { problem = error.getMessage(); }
            String result = outcome, failure = problem;
            runOnUiThread(() -> {
                alphaMarketplaceInFlight = false;
                if ("confirmed".equals(result)) {
                    pendingAlphaMarketplace.clear();
                    try {
                        Class.forName("xyz.etherings.player.alpha.AlphaMarketplaceClient")
                                .getMethod("clearPending", android.content.Context.class)
                                .invoke(null, this);
                    } catch (Exception ignored) { }
                    showCopperLevelMessage("Marketplace confirmed", action + " finalized on Devnet.");
                    loadAlphaEconomy();
                    if (selectedMode == Mode.MARKETPLACE) loadAlphaMarketplaceListings();
                    else if (selectedMode == Mode.RINGS) loadAlphaSilverInventory();
                } else {
                    boolean cooldown = "LIST".equals(action) && failure != null &&
                            failure.startsWith("This NFT is in transfer cooldown.");
                    showCopperLevelMessage(cooldown ? "Listing unavailable" :
                            "Marketplace not yet confirmed", failure == null ?
                            "Status is unknown. Check this operation before signing again." : failure);
                }
            });
        });
    }

    private void resumeAlphaMarketplace(JSONObject pending) {
        if (alphaMarketplaceInFlight) return;
        alphaMarketplaceInFlight = true;
        alphaSilverIo.execute(() -> {
            String result = "unknown", problem = null;
            try {
                result = alphaMarketplaceCall("status", new Class<?>[] {
                        android.content.Context.class, String.class }, this,
                        pending.getString("operationId")).getString("status");
            } catch (Exception error) { problem = error.getMessage(); }
            String outcome = result, failure = problem;
            runOnUiThread(() -> {
                alphaMarketplaceInFlight = false;
                if ("confirmed".equals(outcome) || "failed".equals(outcome) ||
                        "not_submitted".equals(outcome)) {
                    try {
                        Class.forName("xyz.etherings.player.alpha.AlphaMarketplaceClient")
                                .getMethod("clearPending", android.content.Context.class)
                                .invoke(null, this);
                    } catch (Exception ignored) { }
                    pendingAlphaMarketplace.clear();
                    if ("confirmed".equals(outcome)) loadAlphaSilverInventory();
                }
                showCopperLevelMessage("Marketplace operation", failure != null ? failure :
                        "Status: " + outcome + ". " +
                                ("unknown".equals(outcome) ?
                                        "Do not sign another transaction yet." :
                                        "You may review a new action if needed."));
            });
        });
    }

    private void beginAlphaSilverLevelUp(SilverInventorySnapshot.Asset ring) {
        if (alphaSilverProgressInFlight || ring.level < 1 || ring.level >= 20) return;
        int cost = 5 * (ring.level + 2);
        String eru = ring.level == 4 ? "38.76" : ring.level == 19 ? "76.50" : "0";
        new AlertDialog.Builder(this)
                .setTitle("Silver Level " + ring.level + " to " + (ring.level + 1))
                .setMessage("Ring: " + ring.mint + "\nPay: " + cost +
                        " ERT; " + eru + " ERU.\n+6 on-chain Points. Sign with your bound wallet?")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Sign and pay", (dialog, which) ->
                        performAlphaSilverLevelUp(ring))
                .show();
    }

    private void performAlphaSilverLevelUp(SilverInventorySnapshot.Asset ring) {
        if (alphaSilverProgressInFlight) return;
        String key = pendingAlphaSilverLevelUp.keyFor("SILVER:" + ring.mint + ":" + ring.level);
        alphaSilverProgressInFlight = true;
        renderAlphaSilverInventory();
        alphaSilverIo.execute(() -> {
            String outcome = "unknown", failure = null;
            try {
                JSONObject prepared = alphaSilverProgressionCall("prepare", new Class<?>[] {
                        android.content.Context.class, String.class, int.class, String.class },
                        this, ring.mint, ring.level, key);
                String operationId = prepared.getString("operationId");
                JSONObject approved = alphaSilverProgressionCall("review", new Class<?>[] {
                        android.content.Context.class, String.class }, this, operationId);
                JSONObject refreshed = alphaSilverProgressionCall("refresh", new Class<?>[] {
                        android.content.Context.class, String.class, JSONObject.class },
                        this, operationId, approved);
                byte[] signature = (byte[]) Class.forName(
                        "xyz.etherings.player.alpha.AlphaSilverProgressionClient")
                        .getMethod("signReviewed", android.content.Context.class, JSONObject.class,
                                JSONObject.class, String.class, int.class)
                        .invoke(null, this, approved, refreshed, ring.mint, ring.level);
                alphaSilverProgressionCall("submit", new Class<?>[] { android.content.Context.class,
                        String.class, JSONObject.class, byte[].class },
                        this, operationId, refreshed, signature);
                for (int attempt = 0; attempt < 20; attempt++) {
                    JSONObject status = alphaSilverProgressionCall("status", new Class<?>[] {
                            android.content.Context.class, String.class }, this, operationId);
                    outcome = status.optString("status", "unknown");
                    if ("confirmed".equals(outcome)) break;
                    Thread.sleep(1000);
                }
            } catch (Exception error) { failure = error.getMessage(); }
            String finalOutcome = outcome, problem = failure;
            runOnUiThread(() -> {
                alphaSilverProgressInFlight = false;
                if ("confirmed".equals(finalOutcome)) {
                    pendingAlphaSilverLevelUp.clear();
                    String silverEruCost = ring.level == 4 ? " + 38.76 ERU" :
                            ring.level == 19 ? " + 76.50 ERU" : "";
                    showCopperLevelMessage("Silver Level " + (ring.level + 1) + " complete",
                            (5 * (ring.level + 2)) + " ERT" + silverEruCost +
                                    " settled; +6 on-chain Points added.");
                    loadAlphaSilverInventory();
                    loadAlphaEconomy();
                } else {
                    showCopperLevelMessage(problem != null &&
                                    (problem.startsWith("Unlist this Silver Ring") ||
                                            problem.startsWith("This NFT is in transfer cooldown.")) ?
                                    "Silver Level-Up unavailable" : "Silver Level-Up not yet confirmed",
                            problem == null ? "Submission status is unknown. Do not sign a new operation; refresh Ring state." : problem);
                    if (ring.mint.equals(alphaSilverDetailMint)) renderAlphaSilverInventory();
                }
            });
        });
    }

    private void ensureAlphaSilverDraft(SilverInventorySnapshot.Asset ring) {
        String state = ring.unspentPoints + ":" + ring.comfort + ":" + ring.charm + ":" +
                ring.quality + ":" + ring.luck;
        if (!ring.mint.equals(alphaSilverDraftMint) || !state.equals(alphaSilverDraftState)) {
            alphaSilverDraftMint = ring.mint;
            alphaSilverDraftState = state;
            java.util.Arrays.fill(alphaSilverDraft, 0);
        }
    }

    private int silverDraftTotal() {
        return alphaSilverDraft[0] + alphaSilverDraft[1] + alphaSilverDraft[2] + alphaSilverDraft[3];
    }

    private JSONObject silverDraftAllocation() throws org.json.JSONException {
        return new JSONObject().put("comfort", alphaSilverDraft[0])
                .put("charm", alphaSilverDraft[1]).put("quality", alphaSilverDraft[2])
                .put("luck", alphaSilverDraft[3]);
    }

    private LinearLayout silverAttributeRow(SilverInventorySnapshot.Asset ring,
            String label, int value, int index) {
        LinearLayout row = detailMetricRow(label, String.valueOf(value));
        boolean canAdd = ring.unspentPoints != null && ring.unspentPoints > silverDraftTotal()
                && !alphaSilverProgressInFlight && !alphaEquipInFlight;
        renderAttributePointRow(row, label, value, alphaSilverDraft[index],
                ring.unspentPoints != null && ring.unspentPoints > 0, canAdd, () -> {
            if (ring.unspentPoints > silverDraftTotal() && !alphaSilverProgressInFlight) {
                alphaSilverDraft[index]++;
                renderAlphaSilverDetail(ring);
            }
        });
        return row;
    }

    private LinearLayout silverDraftActions(SilverInventorySnapshot.Asset ring) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        FrameLayout clear = compactRingActionSlot("CLEAR", !alphaSilverProgressInFlight);
        clear.setOnClickListener(view -> {
            java.util.Arrays.fill(alphaSilverDraft, 0);
            renderAlphaSilverDetail(ring);
        });
        FrameLayout confirm = compactRingActionSlot("CONFIRM", !alphaSilverProgressInFlight);
        confirm.setOnClickListener(view -> beginAlphaSilverAllocation(ring));
        row.addView(clear);
        row.addView(confirm);
        return row;
    }

    private void beginAlphaSilverAllocation(SilverInventorySnapshot.Asset ring) {
        if (alphaSilverProgressInFlight || silverDraftTotal() < 1 ||
                silverDraftTotal() > ring.unspentPoints) return;
        final JSONObject allocation;
        try { allocation = silverDraftAllocation(); }
        catch (org.json.JSONException error) { throw new IllegalStateException(error); }
        String message = "Comfort +" + alphaSilverDraft[0] + "\nCharm +" + alphaSilverDraft[1]
                + "\nQuality +" + alphaSilverDraft[2] + "\nLuck +" + alphaSilverDraft[3]
                + "\n\nAccumulated points remaining: " + (ring.unspentPoints - silverDraftTotal())
                + "\n\nThis on-chain allocation is permanent.";
        new AlertDialog.Builder(this).setTitle("Confirm point distribution")
                .setMessage(message).setNegativeButton("Cancel", null)
                .setPositiveButton("Confirm", (dialog, which) ->
                        performAlphaSilverAllocation(ring, allocation)).show();
    }

    private void performAlphaSilverAllocation(SilverInventorySnapshot.Asset ring,
            JSONObject allocation) {
        if (alphaSilverProgressInFlight) return;
        alphaSilverProgressInFlight = true;
        renderAlphaSilverInventory();
        alphaSilverIo.execute(() -> {
            String outcome = "unknown", failure = null;
            try {
                JSONObject approved = alphaSilverProgressionCall("reviewAllocation",
                        new Class<?>[] { android.content.Context.class, String.class, JSONObject.class },
                        this, ring.mint, allocation);
                JSONObject refreshed = alphaSilverProgressionCall("refreshAllocation",
                        new Class<?>[] { android.content.Context.class, JSONObject.class },
                        this, approved);
                byte[] signature = (byte[]) Class.forName(
                        "xyz.etherings.player.alpha.AlphaSilverProgressionClient")
                        .getMethod("signAllocationReviewed", android.content.Context.class,
                                JSONObject.class, JSONObject.class, String.class, JSONObject.class)
                        .invoke(null, this, approved, refreshed, ring.mint, allocation);
                String transaction = (String) Class.forName(
                        "xyz.etherings.player.alpha.AlphaSilverProgressionClient")
                        .getMethod("allocationSignature", byte[].class)
                        .invoke(null, (Object) signature);
                String submitFailure = null;
                try {
                    JSONObject submission = alphaSilverProgressionCall("submitAllocation",
                            new Class<?>[] { android.content.Context.class, JSONObject.class, byte[].class },
                            this, refreshed, signature);
                    if (!transaction.equals(submission.getString("signature")))
                        throw new IllegalStateException("Silver allocation signature mismatch");
                } catch (Exception error) {
                    submitFailure = error.getMessage();
                }
                long deadline = android.os.SystemClock.elapsedRealtime() + 60_000L;
                do {
                    try {
                        JSONObject status = alphaSilverProgressionCall("allocationStatus",
                                new Class<?>[] { android.content.Context.class, String.class },
                                this, transaction);
                        outcome = status.optString("status", "unknown");
                        if ("confirmed".equals(outcome)) break;
                    } catch (Exception error) {
                        if (submitFailure == null) submitFailure = error.getMessage();
                    }
                    if (android.os.SystemClock.elapsedRealtime() >= deadline) break;
                    Thread.sleep(1000);
                } while (android.os.SystemClock.elapsedRealtime() < deadline);
                if (!"confirmed".equals(outcome)) failure = submitFailure;
            } catch (Exception error) { failure = error.getMessage(); }
            String finalOutcome = outcome, problem = failure;
            runOnUiThread(() -> {
                alphaSilverProgressInFlight = false;
                if ("confirmed".equals(finalOutcome)) {
                    showCopperLevelMessage("Points applied", "Silver Points distribution confirmed on-chain.");
                    loadAlphaSilverInventory();
                } else {
                    showCopperLevelMessage(problem != null && problem.startsWith("Unlist this Silver Ring") ?
                                    "Silver allocation unavailable" : "Silver allocation not yet confirmed",
                            problem == null ? "Check Ring state before signing again." : problem);
                    if (ring.mint.equals(alphaSilverDetailMint)) renderAlphaSilverInventory();
                }
            });
        });
    }

    private void beginAlphaCooperLevelUp(CopperRing ring) {
        if (alphaCooperProgressInFlight || ring.level() >= 20) return;
        alphaCooperProgressInFlight = true;
        renderAlphaCooperDetail();
        alphaSilverIo.execute(() -> {
            JSONObject preview = null;
            String failure = null;
            try { preview = alphaCooperCall("preview", new Class<?>[] {
                    android.content.Context.class, String.class, int.class },
                    this, ring.id(), ring.level()); }
            catch (Exception error) { failure = error.getMessage(); }
            JSONObject result = preview;
            String problem = failure;
            runOnUiThread(() -> {
                alphaCooperProgressInFlight = false;
                if (!alphaCooperDetail || selectedMode != Mode.RINGS) return;
                renderAlphaCooperDetail();
                if (result == null) { showCopperLevelMessage("Level up unavailable", problem); return; }
                if (!result.optBoolean("available")) {
                    showCopperLevelMessage("Level up unavailable",
                            result.optJSONArray("blockers").toString()); return;
                }
                JSONObject cost = result.optJSONObject("cost");
                String ert = cost.optString("ertDisplay", cost.optString("ertExact"));
                boolean paidEru = cost.optInt("eru") > 0;
                String price = ert + " ERT" + (paidEru ? " + " + cost.optString("eruExact") + " ERU" : "");
                new AlertDialog.Builder(this)
                        .setTitle("Level " + ring.level() + " to " + (ring.level() + 1))
                        .setMessage("Are you ready to pay " + price + " for this level up?\n\n" +
                                "4 accumulated points will be added. You can distribute them later.")
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton("Pay " + price, (dialog, which) -> {
                            if (paidEru) prepareAlphaCooperEru(ring);
                            else performAlphaCooperErt(ring);
                        }).show();
            });
        });
    }

    private void performAlphaCooperErt(CopperRing ring) {
        if (alphaCooperProgressInFlight) return;
        String key = pendingAlphaLevelUp.keyFor(ring.id() + ":" + ring.level());
        alphaCooperProgressInFlight = true;
        renderAlphaCooperDetail();
        alphaSilverIo.execute(() -> {
            String failure = null;
            try { alphaCooperCall("levelUp", new Class<?>[] { android.content.Context.class,
                    String.class, int.class, String.class }, this, ring.id(), ring.level(), key); }
            catch (Exception error) { failure = error.getMessage(); }
            String problem = failure;
            runOnUiThread(() -> {
                alphaCooperProgressInFlight = false;
                if (problem == null) {
                    pendingAlphaLevelUp.clear();
                    showCopperLevelMessage("Level up complete", "Level " + (ring.level() + 1) +
                            " reached. 4 accumulated points added.");
                    loadAlphaSilverInventory();
                    loadAlphaEconomy();
                } else {
                    showCopperLevelMessage("Level up unavailable", problem);
                    if (alphaCooperDetail) renderAlphaCooperDetail();
                }
            });
        });
    }

    private void prepareAlphaCooperEru(CopperRing ring) {
        if (alphaCooperProgressInFlight) return;
        String key = pendingAlphaLevelUp.keyFor(ring.id() + ":" + ring.level());
        alphaCooperProgressInFlight = true;
        renderAlphaCooperDetail();
        alphaSilverIo.execute(() -> {
            JSONObject prepared = null, review = null;
            String failure = null;
            try {
                prepared = alphaCooperCall("prepare", new Class<?>[] {
                        android.content.Context.class, String.class, int.class, String.class },
                        this, ring.id(), ring.level(), key);
                review = alphaCooperCall("review", new Class<?>[] {
                        android.content.Context.class, String.class },
                        this, prepared.getString("operationId"));
            } catch (Exception error) { failure = error.getMessage(); }
            JSONObject approved = review;
            JSONObject reservation = prepared;
            String problem = failure;
            runOnUiThread(() -> {
                alphaCooperProgressInFlight = false;
                if (!alphaCooperDetail || selectedMode != Mode.RINGS) return;
                renderAlphaCooperDetail();
                if (approved == null) {
                    showCopperLevelMessage("ERU review unavailable", problem); return;
                }
                JSONObject terms = approved.optJSONObject("terms");
                new AlertDialog.Builder(this).setTitle("Confirm Level " + (ring.level() + 1) + " on Devnet")
                        .setMessage("Ring: " + ring.id() + "\nWallet: " +
                                terms.optString("walletAddress") + "\nPay: " +
                                terms.optString("ertExact") + " ERT + " +
                                terms.optString("eruPrincipalExact") + " ERU + " +
                                terms.optString("eruFeeExact") + " ERU fee\n" +
                                "Level " + ring.level() + " → " + (ring.level() + 1) +
                                "; +4 Points. Sign with your bound wallet?")
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton("Sign and submit", (dialog, which) ->
                                submitAlphaCooperEru(ring, reservation.optString("operationId"), approved))
                        .show();
            });
        });
    }

    private void submitAlphaCooperEru(CopperRing ring, String operationId, JSONObject approved) {
        if (alphaCooperProgressInFlight) return;
        alphaCooperProgressInFlight = true;
        renderAlphaCooperDetail();
        alphaSilverIo.execute(() -> {
            String outcome = "unknown", failure = null;
            try {
                JSONObject refreshed = alphaCooperCall("refresh", new Class<?>[] {
                        android.content.Context.class, String.class, JSONObject.class },
                        this, operationId, approved);
                byte[] signature = (byte[]) Class.forName(
                        "xyz.etherings.player.alpha.AlphaCooperProgressionClient")
                        .getMethod("signReviewed", android.content.Context.class, JSONObject.class,
                                JSONObject.class, String.class, int.class)
                        .invoke(null, this, approved, refreshed, ring.id(), ring.level());
                alphaCooperCall("submit", new Class<?>[] { android.content.Context.class,
                        String.class, JSONObject.class, byte[].class },
                        this, operationId, refreshed, signature);
                for (int attempt = 0; attempt < 20; attempt++) {
                    JSONObject status = alphaCooperCall("status", new Class<?>[] {
                            android.content.Context.class, String.class }, this, operationId);
                    outcome = status.optString("status", "unknown");
                    if ("confirmed".equals(outcome)) break;
                    Thread.sleep(1000);
                }
            } catch (Exception error) { failure = error.getMessage(); }
            String finalOutcome = outcome, problem = failure;
            runOnUiThread(() -> {
                alphaCooperProgressInFlight = false;
                if ("confirmed".equals(finalOutcome)) {
                    pendingAlphaLevelUp.clear();
                    showCopperLevelMessage("Level " + (ring.level() + 1) + " complete",
                            "ERU payment and Level/+4 Points confirmed.");
                    loadAlphaSilverInventory();
                    loadAlphaEconomy();
                } else {
                    showCopperLevelMessage("ERU Level-Up not yet confirmed", problem == null ?
                            "Submission status is unknown. Do not sign again; refresh Ring state." : problem);
                    if (alphaCooperDetail) renderAlphaCooperDetail();
                }
            });
        });
    }

    private void performAlphaCooperAllocation(CopperRing ring, CopperAttributeAllocation allocation) {
        if (alphaCooperProgressInFlight) return;
        String signature = ring.id() + ":" + ring.unspentAttributePoints() + ":" +
                allocation.comfort() + ":" + allocation.charm() + ":" +
                allocation.quality() + ":" + allocation.luck();
        String key = pendingAlphaAllocation.keyFor(signature);
        alphaCooperProgressInFlight = true;
        renderAlphaCooperDetail();
        alphaSilverIo.execute(() -> {
            String failure = null;
            try { alphaCooperCall("allocate", new Class<?>[] { android.content.Context.class,
                    String.class, int.class, int.class, int.class, int.class, int.class,
                    String.class }, this, ring.id(), ring.unspentAttributePoints(),
                    allocation.comfort(), allocation.charm(), allocation.quality(),
                    allocation.luck(), key); }
            catch (Exception error) { failure = error.getMessage(); }
            String problem = failure;
            runOnUiThread(() -> {
                alphaCooperProgressInFlight = false;
                if (problem == null) {
                    pendingAlphaAllocation.clear();
                    copperAttributeDraft = null;
                    showCopperLevelMessage("Points applied", allocation.total() +
                            " accumulated points distributed.");
                    loadAlphaSilverInventory();
                } else {
                    showCopperLevelMessage("Point distribution unavailable", problem);
                    if (alphaCooperDetail) renderAlphaCooperDetail();
                }
            });
        });
    }

    private void beginAlphaEquip(String kind, String id) {
        if (alphaEquipInFlight || alphaRingEquipment == null ||
                alphaRingEquipment.selection.matches(kind, id)) return;
        AlphaRingEquipmentSnapshot expected = alphaRingEquipment;
        new AlertDialog.Builder(this)
                .setTitle("Equip this Ring?")
                .setMessage("This Ring will replace the currently equipped Ring for M2E.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Equip", (dialog, which) ->
                        performAlphaEquip(kind, id, expected))
                .show();
    }

    private void performAlphaEquip(String kind, String id, AlphaRingEquipmentSnapshot expected) {
        if (alphaEquipInFlight || selectedMode != Mode.RINGS ||
                alphaRingEquipment != expected) return;
        String signature = kind + ":" + id + ":" + expected.selection.kind + ":" +
                expected.selection.id + ":" + expected.version;
        String key = pendingAlphaEquipment.keyFor(signature);
        alphaEquipInFlight = true;
        renderAlphaSilverInventory();
        alphaSilverIo.execute(() -> {
            String result;
            try {
                result = (String) Class.forName(
                        "xyz.etherings.player.alpha.AlphaRingEquipmentClient")
                        .getMethod("equip", android.content.Context.class,
                                AlphaRingEquipmentSnapshot.class, String.class, String.class,
                                String.class)
                        .invoke(null, this, expected, kind, id, key);
            } catch (Exception ignored) { result = "RING_EQUIPMENT_UNAVAILABLE"; }
            String outcome = result;
            runOnUiThread(() -> {
                alphaEquipInFlight = false;
                if (isFinishing() || isDestroyed() || selectedMode != Mode.RINGS) return;
                if ("OK".equals(outcome)) {
                    pendingAlphaEquipment.clear();
                    loadAlphaSilverInventory();
                    return;
                }
                boolean retryable = "RING_EQUIPMENT_UNAVAILABLE".equals(outcome) ||
                        "RING_EQUIPMENT_CHAIN_UNKNOWN".equals(outcome);
                if (!retryable) pendingAlphaEquipment.clear();
                AlertDialog.Builder error = new AlertDialog.Builder(this)
                        .setTitle("Equip unavailable")
                        .setMessage("RING_EQUIPMENT_STALE".equals(outcome) ?
                                "Ring selection changed. Refresh before equipping again." :
                                "SILVER_RING_LISTED".equals(outcome) ?
                                        "This Silver Ring is for sale. Unlist it before equipping." :
                                outcome.startsWith("This NFT is in transfer cooldown.") ? outcome :
                                "RING_EQUIPMENT_CHAIN_UNKNOWN".equals(outcome) ?
                                        "Silver chain eligibility cannot be verified yet." :
                                        "Ring Equip could not be confirmed: " + outcome)
                        .setNegativeButton("Close", null);
                if (retryable) error.setPositiveButton("Retry", (dialog, which) ->
                        performAlphaEquip(kind, id, expected));
                error.show();
                if (!retryable) loadAlphaSilverInventory();
                else renderAlphaSilverInventory();
            });
        });
    }

    private void checkAlphaSilverOpening(SilverInventorySnapshot.Asset asset, TextView state,
            TextView review, TextView sign) {
        checkAlphaSilverOpening(asset, state, review, sign, 0);
    }

    private void checkAlphaSilverOpening(SilverInventorySnapshot.Asset asset, TextView state,
            TextView review, TextView sign, int attempt) {
        int request = alphaSilverGeneration;
        state.setText("Checking opening readiness...");
        alphaSilverIo.execute(() -> {
            SilverOpeningReadiness ready = null;
            try {
                ready = (SilverOpeningReadiness) Class.forName(
                        "xyz.etherings.player.alpha.AlphaSilverInventoryClient")
                        .getMethod("checkOpening", android.content.Context.class, String.class)
                        .invoke(null, this, asset.mint);
            } catch (Exception ignored) { }
            SilverOpeningReadiness result = ready;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || selectedMode != Mode.RINGS ||
                        request != alphaSilverGeneration || !asset.mint.equals(alphaSilverDetailMint)) return;
                if (result == null && attempt < 3) {
                    state.setText("Preparing Box opening...");
                    mainHandler.postDelayed(() -> {
                        if (!isFinishing() && !isDestroyed() && selectedMode == Mode.RINGS &&
                                request == alphaSilverGeneration &&
                                asset.mint.equals(alphaSilverDetailMint))
                            checkAlphaSilverOpening(asset, state, review, sign, attempt + 1);
                    }, 15_000);
                    return;
                }
                state.setText(result == null ? "Opening readiness unavailable. Reopen Box to retry." :
                        (BuildConfig.ALPHA_SILVER_OPENING_SIGN_ENABLED ?
                                "Opening preflight passed.\nEscrow: " :
                                "Read-only preflight passed. Opening remains disabled.\nEscrow: ") +
                                result.escrowAddress);
                if (result != null && BuildConfig.ALPHA_SILVER_CANDIDATE_REVIEW_ENABLED) {
                    review.setVisibility(View.VISIBLE);
                    review.setOnClickListener(view -> reviewAlphaSilverOpening(asset, result, state, review, sign));
                }
            });
        });
    }

    private void reviewAlphaSilverOpening(SilverInventorySnapshot.Asset asset,
            SilverOpeningReadiness ready, TextView state, TextView reviewButton, TextView sign) {
        int request = alphaSilverGeneration;
        sign.setVisibility(View.GONE);
        state.setText("Checking Silver opening...");
        alphaSilverIo.execute(() -> {
            Bundle review = null;
            try {
                review = (Bundle) Class.forName(
                        "xyz.etherings.player.alpha.AlphaSilverInventoryClient")
                        .getMethod("reviewOpening", android.content.Context.class, String.class,
                                String.class)
                        .invoke(null, this, asset.mint, ready.escrowAddress);
            } catch (Exception ignored) { }
            Bundle result = review;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || selectedMode != Mode.RINGS ||
                        request != alphaSilverGeneration || !asset.mint.equals(alphaSilverDetailMint)) return;
                state.setText(result == null ? "Silver opening review unavailable" :
                        "Opening review ready. Inspect details before signing.");
                if (result != null && BuildConfig.ALPHA_SILVER_OPENING_SIGN_ENABLED) {
                    reviewButton.setVisibility(View.GONE);
                    sign.setVisibility(View.VISIBLE);
                    sign.setOnClickListener(view -> confirmAlphaSilverOpening(asset, result, state, sign));
                }
            });
        });
    }

    private void confirmAlphaSilverOpening(SilverInventorySnapshot.Asset asset, Bundle review,
            TextView state, TextView sign) {
        if (!BuildConfig.ALPHA_SILVER_OPENING_SIGN_ENABLED) return;
        new AlertDialog.Builder(this).setTitle("Confirm Silver Box opening")
                .setMessage(review.getString("display"))
                .setNegativeButton("Cancel", (dialog, which) -> { })
                .setPositiveButton("Sign opening", (dialog, which) -> {
                    sign.setVisibility(View.GONE);
                    state.setText("Submitting Silver opening...");
                    int request = alphaSilverGeneration;
                    alphaSilverIo.execute(() -> {
                        String status = "unknown";
                        try {
                            status = (String) Class.forName(
                                    "xyz.etherings.player.alpha.AlphaSilverInventoryClient")
                                    .getMethod("signOpening", android.content.Context.class, Bundle.class)
                                    .invoke(null, this, review);
                        } catch (Exception ignored) { status = "rejected"; }
                        String result = status;
                        runOnUiThread(() -> {
                            if (isFinishing() || isDestroyed() || selectedMode != Mode.RINGS ||
                                    request != alphaSilverGeneration ||
                                    !asset.mint.equals(alphaSilverDetailMint)) return;
                            if ("confirmed".equals(result)) {
                                state.setText("Opening started. Box in escrow; waiting for Ring.");
                                loadAlphaSilverInventory();
                            } else {
                                state.setText("Silver opening: " + result +
                                        ("unknown".equals(result) ?
                                                "\nCheck chain status; do not sign again." : ""));
                            }
                        });
                    });
                }).show();
    }

    private void renderSelectedMode() {
        if (currentProfile == null) {
            showLoginForm(null);
            return;
        }
        hideLoginForm();
        updateModeTabs();

        String displayName = currentProfile.displayName().isEmpty() ? "Player" : currentProfile.displayName();
        renderHeaderBalances();
        renderStepProgress();
        panelTitleView.setText(modeTitle(selectedMode, displayName));
        panelTitleView.setTextColor(textColor);
        panelBodyView.setText(modeBody(selectedMode));
        panelBodyView.setTextColor(mutedColor);
        balanceView.setText("ERT balance: " + currentProfile.ertBalanceDisplay());
        renderWalkStatus();
        raffleView.setText("Draws today: " + currentProfile.raffleAttemptsToday());
        updateModeContentVisibility();
        stepStatusView.setText(trackingStatusMessage());

        if (selectedMode == Mode.WALK || selectedMode == Mode.RINGS) {
            renderCopperRingState();
        }

        if (selectedMode == Mode.DRAW) {
            if (!raffleCurrentLoaded && !raffleCurrentLoading) {
                loadRaffleCurrent();
            }
        }
    }

    private void loadCopperRingInventory() {
        if (currentProfile == null) return;
        copperRingDetailId = null;
        String ownerId = currentProfile.userId();
        int requestGeneration = ++copperRingRequestGeneration;
        copperRingUiState = CopperRingUiState.loadingInventory();
        renderCopperRingState();
        new Thread(() -> {
            CopperRingRepository.Result<List<CopperRing>> result = copperRingRepository.loadInventory();
            runOnUiThread(() -> {
                if (!isCurrentCopperRingRequest(ownerId, requestGeneration)) return;
                copperRingUiState = CopperRingUiState.fromInventory(result);
                renderCopperRingState();
                handleCopperRingSessionExpiry();
            });
        }).start();
    }

    private void loadEquippedCopperRing() {
        if (currentProfile == null) return;
        copperRingDetailId = null;
        String ownerId = currentProfile.userId();
        int requestGeneration = ++copperRingRequestGeneration;
        copperRingUiState = CopperRingUiState.loadingWalk();
        renderCopperRingState();
        new Thread(() -> {
            CopperRingRepository.Result<EquippedCopperRing> result = copperRingRepository.loadEquipped();
            runOnUiThread(() -> {
                if (!isCurrentCopperRingRequest(ownerId, requestGeneration)) return;
                copperRingUiState = CopperRingUiState.fromEquipped(result);
                renderCopperRingState();
                handleCopperRingSessionExpiry();
            });
        }).start();
    }

    private void retryCopperRingLoad() {
        if (copperRingUiState != null && copperRingUiState.screen() == CopperRingUiState.Screen.DETAIL
                && copperRingDetailId != null) {
            openCopperRingDetailById(copperRingDetailId, copperRingDetailReturnMode);
            return;
        }
        if (copperRingUiState != null
                && copperRingUiState.screen() == CopperRingUiState.Screen.INVENTORY) {
            loadCopperRingInventory();
            return;
        }
        loadEquippedCopperRing();
    }

    private void openEquippedCopperRingDetail() {
        if (currentProfile == null || copperRingUiState == null
                || copperRingUiState.screen() != CopperRingUiState.Screen.WALK) return;
        CopperRing ring = copperRingUiState.firstRing();
        if (ring == null) return;
        openCopperRingDetailById(ring.id(), Mode.WALK);
    }

    private void openCopperRingDetailById(String ringId, Mode returnMode) {
        if (currentProfile == null) return;
        copperRingDetailId = ringId;
        copperRingDetailReturnMode = returnMode;
        String ownerId = currentProfile.userId();
        int requestGeneration = ++copperRingRequestGeneration;
        copperRingUiState = CopperRingUiState.loadingDetail();
        renderCopperRingState();
        new Thread(() -> {
            CopperRingRepository.Result<CopperRing> result = copperRingRepository.loadDetail(ringId);
            runOnUiThread(() -> {
                if (!isCurrentCopperRingRequest(ownerId, requestGeneration)) return;
                copperRingUiState = CopperRingUiState.fromDetail(result);
                renderCopperRingState();
                handleCopperRingSessionExpiry();
            });
        }).start();
    }

    private boolean isCurrentCopperRingRequest(String ownerId, int requestGeneration) {
        return currentProfile != null
                && ownerId.equals(currentProfile.userId())
                && ownerId.equals(copperRingOwnerId)
                && requestGeneration == copperRingRequestGeneration;
    }

    private void handleCopperRingSessionExpiry() {
        if (copperRingUiState != null
                && copperRingUiState.status() == CopperRingUiState.Status.SESSION_EXPIRED) {
            String message = copperRingUiState.message();
            clearProfileUiState();
            showLoginForm(message);
        }
    }

    private void renderCopperRingState() {
        if ((selectedMode != Mode.WALK && selectedMode != Mode.RINGS)
                || currentProfile == null || copperRingUiState == null) return;

        CopperRingUiState state = copperRingUiState;
        if ((selectedMode == Mode.WALK && state.screen() == CopperRingUiState.Screen.INVENTORY)
                || (selectedMode == Mode.RINGS && state.screen() == CopperRingUiState.Screen.WALK)
                || (state.screen() == CopperRingUiState.Screen.DETAIL
                && selectedMode != copperRingDetailReturnMode)) {
            return;
        }
        boolean walk = state.screen() == CopperRingUiState.Screen.WALK;
        boolean inventory = state.screen() == CopperRingUiState.Screen.INVENTORY;
        boolean detail = state.screen() == CopperRingUiState.Screen.DETAIL;
        CopperRing ring = detail ? state.ring() : state.firstRing();
        boolean content = ring != null;

        panelTitleView.setVisibility(View.VISIBLE);
        panelBodyView.setVisibility(View.VISIBLE);
        panelTitleView.setTextColor(state.status() == CopperRingUiState.Status.UNAVAILABLE ? errorColor : textColor);
        panelBodyView.setTextColor(textColor);
        copperRingStatusView.setVisibility(View.GONE);
        copperRingArtworkView.setVisibility(content && !inventory ? View.VISIBLE : View.GONE);
        copperRingInventoryView.setVisibility(View.GONE);
        copperRingDetailScrollView.setVisibility(View.GONE);
        copperRingRetryView.setVisibility(state.isRetryable() ? View.VISIBLE : View.GONE);
        if (content) {
            copperRingArtworkView.setImageResource(CopperRingVisualCatalog.drawableFor(ring.visualVariantCode()));
            copperRingArtworkView.setContentDescription(CopperRingUiText.contentDescription(ring));
        }

        if (state.status() == CopperRingUiState.Status.LOADING) {
            panelTitleView.setText(detail ? "Loading Cooper ring" : inventory ? "Loading inventory" : "Loading ring");
            panelBodyView.setText(detail
                    ? "Loading ring details..."
                    : inventory ? "Loading your Cooper rings..." : "Loading your equipped Cooper ring...");
        } else if (state.status() == CopperRingUiState.Status.EMPTY) {
            panelTitleView.setText(detail ? "Cooper ring not found" : inventory ? "Ring inventory" : "No Cooper ring");
            panelBodyView.setText(detail
                    ? "This ring is no longer available."
                    : inventory ? "Your ring inventory is empty." : "Your free Cooper ring is not available yet.");
        } else if (state.status() == CopperRingUiState.Status.CONTENT) {
            renderCopperRingContent(state, ring);
        } else if (state.status() == CopperRingUiState.Status.OFFLINE_STALE) {
            if (state.hasRingContent()) renderCopperRingContent(state, ring);
            else {
                panelTitleView.setText("No saved Cooper ring");
                panelBodyView.setText("No saved Cooper ring.");
            }
            copperRingStatusView.setText("Offline data saved " + formatCopperCacheTime(state.cachedAtMs()) + ".");
            copperRingStatusView.setVisibility(View.VISIBLE);
        } else if (state.status() == CopperRingUiState.Status.SESSION_EXPIRED) {
            panelTitleView.setText("Session expired");
            panelBodyView.setText(state.message());
        } else {
            panelTitleView.setText("Cooper ring unavailable");
            panelBodyView.setText(state.message());
        }
    }

    private void renderCopperRingContent(CopperRingUiState state, CopperRing ring) {
        if (state.screen() == CopperRingUiState.Screen.WALK) {
            panelTitleView.setVisibility(View.GONE);
            panelBodyView.setVisibility(View.GONE);
            return;
        }
        if (state.screen() == CopperRingUiState.Screen.INVENTORY) {
            panelTitleView.setText("Ring inventory");
            panelBodyView.setVisibility(View.GONE);
            copperRingArtworkView.setVisibility(View.GONE);
            renderCopperRingInventory(state.rings());
            copperRingInventoryView.setVisibility(View.VISIBLE);
            return;
        }
        panelTitleView.setVisibility(View.GONE);
        panelBodyView.setVisibility(View.GONE);
        renderCopperRingDetailMetrics(ring);
        copperRingDetailScrollView.setVisibility(View.VISIBLE);
    }

    private void renderCopperRingInventory(List<CopperRing> rings) {
        copperRingInventoryListView.removeAllViews();
        for (int index = 0; index < rings.size(); index += 2) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.TOP);
            row.setLayoutParams(new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
            ));
            row.addView(copperRingInventoryCard(rings.get(index)));
            if (index + 1 < rings.size()) {
                row.addView(copperRingInventoryCard(rings.get(index + 1)));
            } else {
                View spacer = new View(this);
                spacer.setLayoutParams(new LinearLayout.LayoutParams(0, dp(1), 1f));
                row.addView(spacer);
            }
            copperRingInventoryListView.addView(row);
        }
    }

    private ImageView copperRingInventoryCard(CopperRing ring) {
        return copperRingInventoryCard(ring, ring.equipped(),
                view -> openCopperRingDetailById(ring.id(), Mode.RINGS));
    }

    private ImageView copperRingInventoryCard(CopperRing ring, boolean equipped,
            View.OnClickListener onClick) {
        ImageView card = new ImageView(this);
        card.setImageResource(BuildConfig.IS_ALPHA_DEV ? R.drawable.copper_ring_placeholder :
                CopperRingVisualCatalog.drawableFor(ring.visualVariantCode()));
        card.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        card.setContentDescription(CopperRingUiText.contentDescription(ring));
        card.setPadding(
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.space_sm)
        );
        card.setBackground(new BorderDrawable(
                equipped ? accentColor : outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_panel),
                elevatedPanelColor
        ));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(150), 1f);
        params.setMargins(
                dimensionPixelSize(R.dimen.space_xs),
                dimensionPixelSize(R.dimen.space_xs),
                dimensionPixelSize(R.dimen.space_xs),
                dimensionPixelSize(R.dimen.space_xs)
        );
        card.setLayoutParams(params);
        card.setOnClickListener(onClick);
        return card;
    }

    private void renderCopperRingDetailMetrics(CopperRing ring) {
        ensureCopperAttributeDraft(ring);
        copperRingDetailMetricsView.removeAllViews();
        copperRingDetailMetricsView.addView(detailMetricPairRow(
                "Rarity", "Cooper", "Level", String.valueOf(ring.level())
        ));
        copperRingDetailMetricsView.addView(detailAttributePairRow(
                ring, "Comfort", ring.comfort(), 0, "Charm", ring.charm(), 1));
        copperRingDetailMetricsView.addView(detailAttributePairRow(
                ring, "Quality", ring.quality(), 2, "Luck", ring.luck(), 3));
        copperRingDetailMetricsView.addView(detailMetricPairRow(
                "Points", String.valueOf(ring.unspentAttributePoints()), "Shine", ring.shine() + "%"
        ));
        if (copperAttributeDraft.total() > 0) {
            copperRingDetailMetricsView.addView(copperAttributeDraftActions(ring));
        }
        copperRingDetailMetricsView.addView(copperRingActionRow(ring));
    }

    private void ensureCopperAttributeDraft(CopperRing ring) {
        if (!ring.id().equals(copperAttributeDraftRingId)
                || copperAttributeDraft == null
                || copperAttributeDraft.expectedUnspentPoints() != ring.unspentAttributePoints()) {
            copperAttributeDraftRingId = ring.id();
            copperAttributeDraft = new CopperAttributeDraft(ring.unspentAttributePoints());
            pendingAllocation.clear();
        }
    }

    private LinearLayout detailAttributePairRow(
            CopperRing ring, String firstLabel, int firstValue, int firstIndex,
            String secondLabel, int secondValue, int secondIndex
    ) {
        return detailAttributePairRow(
                detailAttributeRow(ring, firstLabel, firstValue, firstIndex),
                detailAttributeRow(ring, secondLabel, secondValue, secondIndex));
    }

    private LinearLayout detailAttributePairRow(
            SilverInventorySnapshot.Asset ring, String firstLabel, int firstValue, int firstIndex,
            String secondLabel, int secondValue, int secondIndex
    ) {
        return detailAttributePairRow(
                silverAttributeRow(ring, firstLabel, firstValue, firstIndex),
                silverAttributeRow(ring, secondLabel, secondValue, secondIndex));
    }

    private LinearLayout detailAttributePairRow(LinearLayout first, LinearLayout second) {
        LinearLayout pair = new LinearLayout(this);
        pair.setOrientation(LinearLayout.HORIZONTAL);
        pair.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout.LayoutParams firstParams = new LinearLayout.LayoutParams(
                0, dimensionPixelSize(R.dimen.ring_detail_row_height), 1f);
        firstParams.rightMargin = dimensionPixelSize(R.dimen.space_xs);
        firstParams.bottomMargin = dimensionPixelSize(R.dimen.ring_detail_row_gap);
        first.setLayoutParams(firstParams);
        pair.addView(first);
        LinearLayout.LayoutParams secondParams = new LinearLayout.LayoutParams(
                0, dimensionPixelSize(R.dimen.ring_detail_row_height), 1f);
        secondParams.leftMargin = dimensionPixelSize(R.dimen.space_xs);
        secondParams.bottomMargin = dimensionPixelSize(R.dimen.ring_detail_row_gap);
        second.setLayoutParams(secondParams);
        pair.addView(second);
        return pair;
    }

    private LinearLayout detailAttributeRow(CopperRing ring, String label, int value, int attributeIndex) {
        LinearLayout row = detailMetricRow(label, String.valueOf(value));
        int selected = copperAttributeDraft.pointsFor(attributeIndex);
        boolean authoritative = BuildConfig.IS_ALPHA_DEV ? alphaCooperDetail &&
                alphaStarterInventory != null : copperRingUiState != null
                && copperRingUiState.status() == CopperRingUiState.Status.CONTENT;
        boolean hasUnspentPoints = copperAttributeDraft.hasUnspentPoints();
        boolean canAdd = authoritative && hasUnspentPoints
                && !copperLevelUpInFlight && !copperAllocationInFlight && !copperEquipmentInFlight
                && copperAttributeDraft.total() < ring.unspentAttributePoints();
        renderAttributePointRow(row, label, value, selected, hasUnspentPoints, canAdd, () -> {
            if (copperAttributeDraft.add(attributeIndex)) {
                pendingAllocation.clear();
                renderCopperRingDetailMetrics(ring);
            }
        });
        return row;
    }

    private void renderAttributePointRow(LinearLayout row, String label, int value,
            int selected, boolean hasUnspentPoints, boolean canAdd, Runnable onAdd) {
        TextView valueView = (TextView) row.getChildAt(1);
        if (selected > 0) {
            String baseValue = String.valueOf(value);
            String selectedValue = " +" + selected;
            SpannableString displayedValue = new SpannableString(baseValue + selectedValue);
            displayedValue.setSpan(
                    new ForegroundColorSpan(accentColor),
                    baseValue.length(),
                    displayedValue.length(),
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            );
            valueView.setText(displayedValue);
        }

        TextView plus = compactRingAction("+", canAdd);
        FrameLayout plusTarget = (FrameLayout) row.getChildAt(2);
        plusTarget.setVisibility(hasUnspentPoints ? View.VISIBLE : View.INVISIBLE);
        plusTarget.setEnabled(canAdd);
        plusTarget.setClickable(canAdd);
        plusTarget.setFocusable(canAdd);
        plusTarget.setContentDescription("Add one point to " + label);
        FrameLayout.LayoutParams plusFrame = new FrameLayout.LayoutParams(
                dimensionPixelSize(R.dimen.attribute_plus_frame_size),
                dimensionPixelSize(R.dimen.attribute_plus_frame_size),
                Gravity.END | Gravity.CENTER_VERTICAL
        );
        plus.setLayoutParams(plusFrame);
        plus.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        plusTarget.addView(plus);
        plusTarget.setOnClickListener(view -> onAdd.run());
        expandAttributeActionTouchTarget(row, plusTarget);
    }

    private void expandAttributeActionTouchTarget(View parent, View target) {
        parent.post(() -> {
            Rect bounds = new Rect();
            target.getHitRect(bounds);
            int missingWidth = dimensionPixelSize(R.dimen.touch_target) - bounds.width();
            if (missingWidth > 0) {
                bounds.left -= missingWidth;
            }
            parent.setTouchDelegate(new TouchDelegate(bounds, target));
        });
    }

    private LinearLayout copperAttributeDraftActions(CopperRing ring) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        FrameLayout clear = compactRingActionSlot("CLEAR",
                !copperAllocationInFlight && !copperEquipmentInFlight);
        clear.setId(R.id.copper_attribute_clear);
        clear.setOnClickListener(view -> {
            copperAttributeDraft.clear();
            pendingAllocation.clear();
            renderCopperRingDetailMetrics(ring);
        });
        FrameLayout confirm = compactRingActionSlot(
                "CONFIRM", !copperAllocationInFlight && !copperEquipmentInFlight
                        && copperAttributeDraft.canConfirm());
        confirm.setId(R.id.copper_attribute_confirm);
        confirm.setOnClickListener(view -> showCopperAttributeConfirmation(ring));
        row.addView(clear);
        row.addView(confirm);
        return row;
    }

    private LinearLayout copperRingActionRow(CopperRing ring) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        boolean authoritative = copperRingUiState != null
                && copperRingUiState.status() == CopperRingUiState.Status.CONTENT;
        FrameLayout levelUp = compactRingActionSlot("LVLUP", authoritative && ring.level() < 20
                && !copperLevelUpInFlight && !copperAllocationInFlight && !copperEquipmentInFlight);
        levelUp.setId(R.id.copper_ring_level_up);
        levelUp.setOnClickListener(view -> beginCopperLevelUp(ring));
        row.addView(levelUp);
        FrameLayout equip = compactRingActionSlot("EQUIP", authoritative && !ring.equipped()
                && !copperLevelUpInFlight && !copperAllocationInFlight && !copperEquipmentInFlight);
        equip.setId(R.id.copper_ring_equip);
        equip.setOnClickListener(view -> beginCopperEquipment(ring));
        row.addView(equip);
        row.addView(compactRingActionSlot("MINT", false));
        row.addView(compactRingActionSlot("SELL", false));
        return row;
    }

    private FrameLayout compactRingActionSlot(String label, boolean enabled) {
        FrameLayout slot = new HalfHeightActionSlot(this);
        LinearLayout.LayoutParams slotParams = new LinearLayout.LayoutParams(
                0,
                dimensionPixelSize(R.dimen.touch_target),
                1f
        );
        slotParams.setMargins(dp(3), dimensionPixelSize(R.dimen.space_sm), dp(3), 0);
        slot.setLayoutParams(slotParams);
        slot.setEnabled(enabled);
        slot.setClickable(enabled);
        slot.setFocusable(enabled);
        slot.setContentDescription(label);

        TextView frame = baseTab(label, false, !enabled);
        frame.setAutoSizeTextTypeUniformWithConfiguration(
                8,
                12,
                1,
                TypedValue.COMPLEX_UNIT_SP
        );
        frame.setPadding(dp(2), 0, dp(2), 0);
        frame.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        frame.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER
        ));
        slot.addView(frame);
        return slot;
    }

    private TextView compactRingAction(String label, boolean enabled) {
        TextView button = baseTab(label, false, !enabled);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dimensionPixelSize(R.dimen.touch_target), 1f);
        params.setMargins(dp(3), dimensionPixelSize(R.dimen.space_sm), dp(3), 0);
        button.setLayoutParams(params);
        return button;
    }

    private void beginCopperEquipment(CopperRing ring) {
        if (ring.equipped() || copperEquipmentInFlight
                || copperLevelUpInFlight || copperAllocationInFlight) return;
        copperEquipmentInFlight = true;
        renderCopperRingDetailMetrics(ring);
        new Thread(() -> {
            CopperRingRepository.Result<EquippedCopperRing> current = copperRingRepository.loadEquipped();
            runOnUiThread(() -> {
                copperEquipmentInFlight = false;
                if (!isDisplayedRing(ring)) return;
                renderCopperRingDetailMetrics(ring);
                if (!current.isSuccess()) {
                    showCopperLevelMessage("Equip unavailable", current.errorMessage());
                    return;
                }
                if (ring.id().equals(current.value().ring().id())) {
                    openCopperRingDetailById(ring.id(), copperRingDetailReturnMode);
                    return;
                }
                String expectedRingId = current.value().ring().id();
                new AlertDialog.Builder(this)
                        .setTitle("Equip this Ring?")
                        .setMessage("This Ring will replace the currently equipped Ring for M2E.")
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton("Equip", (dialog, which) ->
                                performCopperEquipment(ring, expectedRingId))
                        .show();
            });
        }).start();
    }

    private void performCopperEquipment(CopperRing ring, String expectedRingId) {
        if (copperEquipmentInFlight || copperLevelUpInFlight || copperAllocationInFlight) return;
        String signature = ring.id() + ":" + expectedRingId;
        String idempotencyKey = pendingEquipment.keyFor(signature);
        copperEquipmentInFlight = true;
        renderCopperRingDetailMetrics(ring);
        new Thread(() -> {
            CopperRingRepository.Result<EquippedCopperRing> result = copperRingRepository.equip(
                    ring, expectedRingId, idempotencyKey);
            runOnUiThread(() -> {
                copperEquipmentInFlight = false;
                if (!isDisplayedRing(ring)) return;
                if (result.isSuccess()) {
                    pendingEquipment.clear();
                    copperAttributeDraft = null;
                    showCopperLevelMessage("Ring equipped", "The selected Ring is now active for M2E.");
                    openCopperRingDetailById(ring.id(), copperRingDetailReturnMode);
                    refreshHomeProfileSilently(null);
                    return;
                }
                boolean retryable = result.errorKind() == CopperRingRepository.ErrorKind.BACKEND_UNAVAILABLE;
                AlertDialog.Builder error = new AlertDialog.Builder(this)
                        .setTitle("Equip failed")
                        .setMessage(result.errorMessage())
                        .setNegativeButton("Close", null);
                if (retryable) {
                    error.setPositiveButton("Retry", (dialog, which) ->
                            performCopperEquipment(ring, expectedRingId));
                } else {
                    pendingEquipment.clear();
                }
                error.show();
                if (result.errorKind() == CopperRingRepository.ErrorKind.CONFLICT
                        || result.errorKind() == CopperRingRepository.ErrorKind.IDEMPOTENCY_CONFLICT) {
                    openCopperRingDetailById(ring.id(), copperRingDetailReturnMode);
                } else {
                    renderCopperRingDetailMetrics(ring);
                }
            });
        }).start();
    }

    private void beginCopperLevelUp(CopperRing ring) {
        if (copperLevelUpInFlight || copperAllocationInFlight
                || copperEquipmentInFlight || ring.level() >= 20) return;
        copperLevelUpInFlight = true;
        renderCopperRingDetailMetrics(ring);
        new Thread(() -> {
            CopperRingRepository.Result<CopperLevelPreview> result = copperRingRepository.previewLevelUp(ring);
            runOnUiThread(() -> {
                copperLevelUpInFlight = false;
                if (!isDisplayedRing(ring)) return;
                renderCopperRingDetailMetrics(ring);
                if (!result.isSuccess()) {
                    showCopperLevelMessage("Level up unavailable", result.errorMessage());
                } else if (!result.value().available()) {
                    showCopperLevelMessage("Level up unavailable", levelBlockerText(result.value()));
                } else {
                    showCopperLevelPaymentDialog(ring, result.value());
                }
            });
        }).start();
    }

    private void showCopperLevelPaymentDialog(CopperRing ring, CopperLevelPreview preview) {
        String price = preview.ertCostDisplay() + " ERT"
                + (preview.hasEruCost() ? " + " + preview.eruCostDisplay() + " ERU" : "");
        String message = "Are you ready to pay " + price + " for this level up?\n\n"
                + preview.grantedAttributePoints() + " accumulated points will be added. "
                + "You can distribute them later.";
        new AlertDialog.Builder(this)
                .setTitle("Level " + ring.level() + " to " + preview.targetLevel())
                .setMessage(message)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Pay " + price, (dialog, which) -> performCopperLevelUp(ring, preview))
                .show();
    }

    private void performCopperLevelUp(CopperRing ring, CopperLevelPreview preview) {
        if (copperLevelUpInFlight || copperAllocationInFlight || copperEquipmentInFlight) return;
        String signature = ring.id() + ":" + ring.level() + ":" + preview.targetLevel();
        String idempotencyKey = pendingLevelUp.keyFor(signature);
        copperLevelUpInFlight = true;
        renderCopperRingDetailMetrics(ring);
        new Thread(() -> {
            CopperRingRepository.Result<CopperLevelUpResult> result = copperRingRepository.levelUp(
                    ring, idempotencyKey
            );
            runOnUiThread(() -> {
                copperLevelUpInFlight = false;
                if (!isDisplayedRing(ring)) return;
                if (result.isSuccess()) {
                    pendingLevelUp.clear();
                    copperAttributeDraft = null;
                    showCopperLevelMessage("Level up complete", "Level " + result.value().level()
                            + " reached. " + result.value().grantedAttributePoints()
                            + " accumulated points added. ERT balance: "
                            + result.value().ertBalanceDisplay()
                            + (result.value().hasEruCost()
                            ? ". ERU balance: " + result.value().eruBalanceDisplay()
                            : ""));
                    openCopperRingDetailById(ring.id(), copperRingDetailReturnMode);
                    refreshHomeProfileSilently(null);
                } else {
                    boolean retryable = result.errorKind() == CopperRingRepository.ErrorKind.BACKEND_UNAVAILABLE;
                    AlertDialog.Builder error = new AlertDialog.Builder(this)
                            .setTitle("Level up failed").setMessage(result.errorMessage()).setNegativeButton("Close", null);
                    if (retryable) error.setPositiveButton("Retry", (dialog, which) -> performCopperLevelUp(ring, preview));
                    else { pendingLevelUp.clear(); }
                    error.show();
                    renderCopperRingDetailMetrics(ring);
                }
            });
        }).start();
    }

    private void showCopperAttributeConfirmation(CopperRing ring) {
        if (copperAttributeDraft == null || !copperAttributeDraft.canConfirm()
                || copperAllocationInFlight || copperLevelUpInFlight || copperEquipmentInFlight) return;
        CopperAttributeAllocation allocation = copperAttributeDraft.allocation();
        String message = "Comfort +" + allocation.comfort()
                + "\nCharm +" + allocation.charm()
                + "\nQuality +" + allocation.quality()
                + "\nLuck +" + allocation.luck()
                + "\n\nAccumulated points remaining: " + copperAttributeDraft.remainingAfterConfirmation()
                + "\n\nThis allocation is permanent.";
        new AlertDialog.Builder(this)
                .setTitle("Confirm point distribution")
                .setMessage(message)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Confirm", (dialog, which) -> {
                    if (BuildConfig.IS_ALPHA_DEV) performAlphaCooperAllocation(ring, allocation);
                    else performCopperAttributeAllocation(ring, allocation);
                })
                .show();
    }

    private void performCopperAttributeAllocation(CopperRing ring, CopperAttributeAllocation allocation) {
        if (copperAllocationInFlight || copperLevelUpInFlight || copperEquipmentInFlight) return;
        String signature = ring.id() + ":" + ring.unspentAttributePoints() + ":"
                + allocation.comfort() + ":" + allocation.charm() + ":"
                + allocation.quality() + ":" + allocation.luck();
        String idempotencyKey = pendingAllocation.keyFor(signature);
        copperAllocationInFlight = true;
        renderCopperRingDetailMetrics(ring);
        new Thread(() -> {
            CopperRingRepository.Result<CopperAttributeAllocationResult> result =
                    copperRingRepository.allocateAttributePoints(ring, allocation, idempotencyKey);
            runOnUiThread(() -> {
                copperAllocationInFlight = false;
                if (!isDisplayedRing(ring)) return;
                if (result.isSuccess()) {
                    pendingAllocation.clear();
                    copperAttributeDraft = null;
                    showCopperLevelMessage("Points applied", allocation.total()
                            + " accumulated points distributed. "
                            + result.value().unspentAttributePoints() + " remaining.");
                    openCopperRingDetailById(ring.id(), copperRingDetailReturnMode);
                } else {
                    boolean retryable = result.errorKind() == CopperRingRepository.ErrorKind.BACKEND_UNAVAILABLE;
                    boolean reload = result.errorKind() == CopperRingRepository.ErrorKind.STALE_POINTS
                            || result.errorKind() == CopperRingRepository.ErrorKind.INSUFFICIENT_POINTS
                            || result.errorKind() == CopperRingRepository.ErrorKind.IDEMPOTENCY_CONFLICT;
                    AlertDialog.Builder error = new AlertDialog.Builder(this)
                            .setTitle("Point distribution failed")
                            .setMessage(result.errorMessage())
                            .setNegativeButton("Close", null);
                    if (retryable) {
                        error.setPositiveButton("Retry", (dialog, which) ->
                                performCopperAttributeAllocation(ring, allocation));
                    } else {
                        pendingAllocation.clear();
                    }
                    error.show();
                    if (reload) {
                        copperAttributeDraft = null;
                        openCopperRingDetailById(ring.id(), copperRingDetailReturnMode);
                    } else {
                        renderCopperRingDetailMetrics(ring);
                    }
                }
            });
        }).start();
    }

    private boolean isDisplayedRing(CopperRing ring) {
        return currentProfile != null && copperRingUiState != null
                && copperRingUiState.screen() == CopperRingUiState.Screen.DETAIL
                && ring.id().equals(copperRingDetailId);
    }

    private String levelBlockerText(CopperLevelPreview preview) {
        if (preview.blockers().contains("INSUFFICIENT_ERT")) return "Not enough ERT. Price: "
                + preview.ertCostDisplay() + " ERT.";
        if (preview.blockers().contains("INSUFFICIENT_ERU")) return "Not enough ERU. Price: "
                + preview.eruCostDisplay() + " ERU. Balance: " + preview.eruBalanceDisplay() + " ERU.";
        return "This level-up is not available.";
    }

    private void showCopperLevelMessage(String title, String message) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(message).setPositiveButton("OK", null).show();
    }

    private LinearLayout detailMetricPairRow(
            String firstLabel,
            String firstValue,
            String secondLabel,
            String secondValue
    ) {
        LinearLayout pair = new LinearLayout(this);
        pair.setOrientation(LinearLayout.HORIZONTAL);
        pair.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout first = detailMetricRow(firstLabel, firstValue);
        LinearLayout.LayoutParams firstParams = new LinearLayout.LayoutParams(
                0,
                dimensionPixelSize(R.dimen.ring_detail_row_height),
                1f
        );
        firstParams.rightMargin = dimensionPixelSize(R.dimen.space_xs);
        firstParams.bottomMargin = dimensionPixelSize(R.dimen.ring_detail_row_gap);
        first.setLayoutParams(firstParams);
        pair.addView(first);

        LinearLayout second = detailMetricRow(secondLabel, secondValue);
        LinearLayout.LayoutParams secondParams = new LinearLayout.LayoutParams(
                0,
                dimensionPixelSize(R.dimen.ring_detail_row_height),
                1f
        );
        secondParams.leftMargin = dimensionPixelSize(R.dimen.space_xs);
        secondParams.bottomMargin = dimensionPixelSize(R.dimen.ring_detail_row_gap);
        second.setLayoutParams(secondParams);
        pair.addView(second);
        return pair;
    }

    private LinearLayout detailMetricRow(String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(
                dimensionPixelSize(R.dimen.space_sm),
                0,
                0,
                0
        );
        row.setBackground(null);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dimensionPixelSize(R.dimen.ring_detail_row_height)
        );
        rowParams.bottomMargin = dimensionPixelSize(R.dimen.ring_detail_row_gap);
        row.setLayoutParams(rowParams);

        TextView labelView = new TextView(this);
        labelView.setText(label);
        labelView.setTextColor(mutedColor);
        labelView.setSingleLine(true);
        setTokenTextSize(labelView, R.dimen.text_label);
        labelView.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(labelView);

        TextView valueView = new TextView(this);
        valueView.setText(value);
        valueView.setTextColor(textColor);
        valueView.setTypeface(null, Typeface.BOLD);
        valueView.setGravity(Gravity.END);
        valueView.setSingleLine(true);
        setTokenTextSize(valueView, R.dimen.text_label);
        row.addView(valueView);

        FrameLayout accessory = new FrameLayout(this);
        accessory.setVisibility(View.INVISIBLE);
        accessory.setLayoutParams(new LinearLayout.LayoutParams(
                dimensionPixelSize(R.dimen.attribute_action_slot_width),
                dimensionPixelSize(R.dimen.ring_detail_row_height)
        ));
        row.addView(accessory);
        return row;
    }

    private String formatCopperCacheTime(long cachedAtMs) {
        if (cachedAtMs <= 0L) return "at an unknown time";
        return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date(cachedAtMs));
    }

    private void loadRaffleCurrent() {
        if (currentProfile == null || raffleCurrentLoading) return;
        String ownerId = currentProfile.userId();
        int generation = ++raffleRequestGeneration;
        raffleCurrentLoading = true;
        renderRafflePoolsMessage("Loading Draw...", mutedColor, false);
        new Thread(() -> {
            RaffleV2ReadRepository.Result<RaffleV2Draw> result = raffleV2ReadRepository.loadCurrent();
            RafflePendingDrawEntity pending = result.isSuccess()
                    ? rafflePendingDrawStore.get(ownerId) : null;
            RaffleV2DrawCoordinator.Result recovered = null;
            if (pending != null && (pending.state == RafflePendingDrawState.COMPLETED_UNREVEALED
                    || pending.state == RafflePendingDrawState.REVEALED)) {
                recovered = raffleV2DrawCoordinator.submitOrResume(result.value());
            }
            RaffleV2DrawCoordinator.Result finalRecovered = recovered;
            runOnUiThread(() -> renderRaffleCurrent(ownerId, generation, result, pending, finalRecovered));
        }).start();
    }

    private void renderRaffleCurrent(String ownerId, int generation,
            RaffleV2ReadRepository.Result<RaffleV2Draw> result,
            RafflePendingDrawEntity pending, RaffleV2DrawCoordinator.Result recovered) {
        if (currentProfile == null || !ownerId.equals(currentProfile.userId())
                || generation != raffleRequestGeneration) return;
        raffleCurrentLoading = false;
        if (!result.isSuccess()) {
            raffleCurrentLoaded = false;
            if (result.errorKind() == RaffleV2ReadRepository.ErrorKind.SESSION_EXPIRED) {
                clearProfileUiState();
                showLoginForm(result.errorMessage());
                return;
            }
            renderRafflePoolsMessage(result.errorMessage(), errorColor, true);
            return;
        }
        raffleCurrentLoaded = true;
        currentRaffleDraw = result.value();
        renderRaffleReady(pending);
        if (recovered != null && recovered.kind() == RaffleV2DrawCoordinator.Kind.COMPLETED) {
            renderValidatedRaffleResult(recovered.evidence(),
                    pending != null && pending.state == RafflePendingDrawState.REVEALED,
                    recovered.idempotencyKey());
        }
    }

    private void renderRaffleReady(RafflePendingDrawEntity pending) {
        RaffleV2UiState uiState = RaffleV2UiState.from(pending);
        ErtValue balance = currentProfile == null
                ? ErtValue.zero()
                : ErtValue.fromExact(currentProfile.ertBalanceExact());
        boolean affordable = RaffleAffordability.canAfford(balance, currentRaffleDraw.cost());
        if (pending == null) {
            raffleDrawResultView.setText("");
            raffleDrawResultView.setVisibility(View.GONE);
        }
        rafflePoolsContainer.removeAllViews();
        raffleWheelView = new RaffleWheelView(this);
        raffleWheelView.setId(R.id.raffle_v2_wheel);
        raffleWheelView.showReady(RaffleWheelModel.fromCurrent(currentRaffleDraw));
        rafflePoolsContainer.addView(raffleWheelView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        raffleAttemptsView = metricText("", "");
        raffleAttemptsView.setId(R.id.raffle_v2_attempts);
        raffleAttemptsView.setText(RaffleAffordability.attemptsLabel(
                currentRaffleDraw.attemptsRemaining(), currentRaffleDraw.attemptLimit()));
        raffleAttemptsView.setGravity(Gravity.CENTER);
        raffleAttemptsView.setTextColor(mutedColor);
        raffleAttemptsView.setPadding(0, dimensionPixelSize(R.dimen.space_sm),
                0, dimensionPixelSize(R.dimen.space_sm));
        rafflePoolsContainer.addView(raffleAttemptsView);

        raffleV2ActionView = formButton(getString(R.string.raffle_v2_acceptance_pending));
        raffleV2ActionView.setId(R.id.raffle_v2_action);
        rafflePoolsContainer.addView(raffleV2ActionView);

        if (uiState.canDismiss()) {
            if (uiState.kind() == RaffleV2UiState.Kind.TERMINAL_REJECTED) {
                raffleDrawResultView.setText("Draw rejected: " + pending.terminalErrorCode);
                raffleDrawResultView.setTextColor(errorColor);
            }
            raffleV2ActionView.setText(R.string.raffle_v2_continue);
            styleRaffleDrawButton(raffleV2ActionView, true);
            raffleV2ActionView.setOnClickListener(view -> clearRaffleTerminal(pending));
            return;
        }
        if (uiState.kind() == RaffleV2UiState.Kind.RECOVERY_REQUIRED) {
            raffleV2ActionView.setText(getString(R.string.raffle_v2_retry_same));
        } else if (uiState.kind() == RaffleV2UiState.Kind.REVEAL_REQUIRED) {
            raffleV2ActionView.setText("Result pending");
        } else {
            raffleV2ActionView.setText(BuildConfig.RAFFLE_V2_PAID_DRAW_ENABLED
                ? RaffleAffordability.readyButtonLabel(balance, currentRaffleDraw.cost(),
                        currentRaffleDraw.attemptsRemaining())
                : getString(R.string.raffle_v2_acceptance_pending));
        }
        boolean enabled = uiState.canSubmit(BuildConfig.RAFFLE_V2_PAID_DRAW_ENABLED)
                && !raffleDrawInFlight
                && currentRaffleDraw.attemptsRemaining() > 0 && affordable;
        styleRaffleDrawButton(raffleV2ActionView, enabled);
        raffleV2ActionView.setOnClickListener(view -> submitRaffleV2Draw());
    }

    private void submitRaffleV2Draw() {
        if (!BuildConfig.RAFFLE_V2_PAID_DRAW_ENABLED || raffleDrawInFlight
                || currentRaffleDraw == null || currentProfile == null) return;
        raffleDrawInFlight = true;
        raffleWheelView.showWaiting(false);
        raffleV2ActionView.setText("Drawing...");
        raffleDrawResultView.setVisibility(View.VISIBLE);
        raffleDrawResultView.setText("Draw in progress...");
        raffleDrawResultView.setTextColor(mutedColor);
        styleRaffleDrawButton(raffleV2ActionView, false);
        new Thread(() -> {
            RaffleV2DrawCoordinator.Result result = raffleV2DrawCoordinator.submitOrResume(currentRaffleDraw);
            runOnUiThread(() -> renderRaffleCommandResult(result));
        }).start();
    }

    private void renderRaffleCommandResult(RaffleV2DrawCoordinator.Result result) {
        raffleDrawInFlight = false;
        raffleCurrentLoaded = false;
        if (result.kind() == RaffleV2DrawCoordinator.Kind.SESSION_REQUIRED) {
            clearProfileUiState();
            showLoginForm("Session expired. Sign in again.");
        } else if (result.kind() == RaffleV2DrawCoordinator.Kind.COMPLETED) {
            renderValidatedRaffleResult(result.evidence(), false, result.idempotencyKey());
        } else if (result.kind() == RaffleV2DrawCoordinator.Kind.UNCERTAIN) {
            raffleWheelView.showWaiting(true);
            raffleDrawResultView.setText("Result is uncertain. Retry uses the same operation.");
            raffleDrawResultView.setTextColor(errorColor);
            loadRaffleCurrent();
        } else {
            raffleWheelView.clear();
            raffleDrawResultView.setText("Draw rejected: " + result.errorCode());
            raffleDrawResultView.setTextColor(errorColor);
            loadRaffleCurrent();
        }
    }

    private void renderValidatedRaffleResult(RaffleV2SelectionEvidence evidence, boolean revealed,
            String idempotencyKey) {
        RaffleWheelModel model = RaffleWheelModel.fromEvidence(evidence, currentRaffleDraw.rewards());
        final int artwork;
        try {
            artwork = RaffleRewardArtwork.drawableFor(evidence.reward());
        } catch (IllegalArgumentException error) {
            raffleDrawResultView.setVisibility(View.VISIBLE);
            raffleDrawResultView.setText("Reward artwork unavailable. Result remains pending.");
            raffleDrawResultView.setTextColor(errorColor);
            raffleV2ActionView.setText("Result pending");
            styleRaffleDrawButton(raffleV2ActionView, false);
            return;
        }
        raffleDrawResultView.setText("");
        raffleDrawResultView.setVisibility(View.GONE);
        raffleWheelView.setOnLandingListener(revealed ? null
                : () -> showRaffleRewardDialog(evidence, idempotencyKey, artwork));
        raffleWheelView.showResult(model, revealed);
    }

    private void styleRaffleDrawButton(TextView button, boolean enabled) {
        button.setEnabled(enabled);
        button.setTextColor(enabled ? onAccentColor : disabledTextColor);
        button.setBackground(new BorderDrawable(
                enabled ? accentColor : outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_control),
                enabled ? accentColor : disabledFillColor
        ));
    }

    private void showRaffleRewardDialog(RaffleV2SelectionEvidence evidence,
            String idempotencyKey, int artworkResource) {
        if (currentProfile == null || idempotencyKey == null) return;
        if (raffleRewardDialog != null && raffleRewardDialog.isShowing()) {
            if (idempotencyKey.equals(raffleRewardDialogKey)) return;
            raffleRewardDialog.dismiss();
        }
        String ownerId = currentProfile.userId();
        LinearLayout content = dialogForm();
        content.setBackground(new BorderDrawable(outlineColor, dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_panel), panelColor));

        ImageView artwork = new ImageView(this);
        artwork.setId(R.id.raffle_v2_reward_artwork);
        artwork.setImageResource(artworkResource);
        artwork.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        artwork.setAdjustViewBounds(true);
        artwork.setContentDescription(getString(R.string.raffle_reward_ack_content_description,
                evidence.reward().title()));
        artwork.setClickable(true);
        artwork.setFocusable(true);
        content.addView(artwork, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dimensionPixelSize(R.dimen.raffle_reward_artwork_size)));

        TextView errorView = dialogMessage();
        errorView.setGravity(Gravity.CENTER);
        content.addView(errorView);

        AlertDialog dialog = new AlertDialog.Builder(this).setView(content).create();
        dialog.setCancelable(false);
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnDismissListener(ignored -> {
            if (raffleRewardDialog == dialog) {
                raffleRewardDialog = null;
                raffleRewardDialogKey = null;
            }
        });
        artwork.setOnClickListener(view -> acknowledgeRaffleReward(
                ownerId, idempotencyKey, dialog, artwork, errorView));
        raffleRewardDialog = dialog;
        raffleRewardDialogKey = idempotencyKey;
        dialog.show();
    }

    private void acknowledgeRaffleReward(String ownerId, String idempotencyKey,
            AlertDialog dialog, ImageView artwork, TextView errorView) {
        artwork.setEnabled(false);
        errorView.setVisibility(View.GONE);
        new Thread(() -> {
            RuntimeException failure = null;
            try {
                RafflePendingDrawEntity pending = rafflePendingDrawStore.get(ownerId);
                if (pending == null || !idempotencyKey.equals(pending.idempotencyKey)) {
                    throw new IllegalStateException("Pending Draw operation changed");
                }
                if (pending.state == RafflePendingDrawState.COMPLETED_UNREVEALED) {
                    rafflePendingDrawStore.acknowledgeCompleted(ownerId, idempotencyKey);
                } else if (pending.state != RafflePendingDrawState.REVEALED) {
                    throw new IllegalStateException("Draw result is not ready for acknowledgement");
                }
            } catch (RuntimeException error) {
                failure = error;
            }
            RuntimeException finalFailure = failure;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (finalFailure != null) {
                    artwork.setEnabled(true);
                    errorView.setText(R.string.raffle_reward_ack_failed);
                    errorView.setTextColor(errorColor);
                    errorView.setVisibility(View.VISIBLE);
                    return;
                }
                dialog.dismiss();
                if (currentProfile == null || !ownerId.equals(currentProfile.userId())) return;
                raffleCurrentLoaded = false;
                loadHomeProfile();
            });
        }).start();
    }

    private void clearRaffleTerminal(RafflePendingDrawEntity pending) {
        if (currentProfile == null) return;
        String ownerId = currentProfile.userId();
        new Thread(() -> {
            rafflePendingDrawStore.clearTerminal(ownerId, pending.idempotencyKey);
            runOnUiThread(() -> {
                raffleCurrentLoaded = false;
                loadRaffleCurrent();
            });
        }).start();
    }

    private LinearLayout raffleHistoryItemView(String snapshot) {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(
                dimensionPixelSize(R.dimen.space_md),
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.space_md),
                dimensionPixelSize(R.dimen.space_sm)
        );
        view.setBackground(new BorderDrawable(
                outlineColor,
                dimension(R.dimen.border_hairline),
                dimension(R.dimen.radius_panel),
                elevatedPanelColor
        ));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.bottomMargin = dimensionPixelSize(R.dimen.space_md);
        view.setLayoutParams(params);

        String titleText = "Draw reward";
        String detailsText = "Completed Draw";
        String createdAtText = "";
        try {
            JSONObject item = new JSONObject(snapshot);
            JSONObject reward = item.getJSONObject("reward");
            titleText = reward.optString("title", titleText);
            detailsText = reward.optString("amountDisplay", reward.optString("type", detailsText));
            createdAtText = item.optString("createdAt", "");
        } catch (JSONException ignored) {
            // The page parser already validates the immutable object shape.
        }
        TextView title = new TextView(this);
        title.setText(titleText);
        setTokenTextSize(title, R.dimen.text_card_title);
        title.setTextColor(textColor);
        title.setTypeface(null, Typeface.BOLD);
        view.addView(title);

        TextView details = new TextView(this);
        details.setText(detailsText);
        setTokenTextSize(details, R.dimen.text_label);
        details.setTextColor(mutedColor);
        details.setPadding(0, dimensionPixelSize(R.dimen.space_xs), 0, 0);
        view.addView(details);

        if (!createdAtText.trim().isEmpty()) {
            TextView createdAt = new TextView(this);
            createdAt.setText(formatHistoryDate(createdAtText));
            setTokenTextSize(createdAt, R.dimen.text_caption);
            createdAt.setTextColor(disabledTextColor);
            createdAt.setPadding(0, dimensionPixelSize(R.dimen.space_xs), 0, 0);
            view.addView(createdAt);
        }
        return view;
    }

    private String formatHistoryDate(String value) {
        String normalized = value == null ? "" : value.trim().replace('T', ' ');
        return normalized.length() > 16 ? normalized.substring(0, 16) + " UTC" : normalized;
    }

    private void renderRafflePoolsMessage(String message, int color, boolean retryable) {
        rafflePoolsContainer.removeAllViews();
        TextView messageView = new TextView(this);
        messageView.setText(message);
        messageView.setGravity(Gravity.CENTER);
        setTokenTextSize(messageView, R.dimen.text_body);
        messageView.setTextColor(color);
        messageView.setPadding(
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.space_lg),
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.space_md)
        );
        rafflePoolsContainer.addView(messageView);

        if (retryable) {
            TextView retry = formButton("Retry draws");
            retry.setOnClickListener(view -> loadRaffleCurrent());
            rafflePoolsContainer.addView(retry);
        }
    }

    private void updateModeContentVisibility() {
        boolean drawMode = currentProfile != null && selectedMode == Mode.DRAW;
        boolean profileSelected = selectedMode == Mode.PROFILE;
        boolean profileMode = currentProfile != null && profileSelected;
        int panelInset = dimensionPixelSize(R.dimen.space_lg);
        modeContentPanelView.setPadding(
                panelInset,
                drawMode ? 0 : panelInset,
                panelInset,
                panelInset
        );
        stepStatusBlockView.setVisibility(profileSelected ? View.GONE : View.VISIBLE);
        copperRingArtworkView.setVisibility(View.GONE);
        copperRingInventoryView.setVisibility(View.GONE);
        copperRingDetailScrollView.setVisibility(View.GONE);
        copperRingStatusView.setVisibility(View.GONE);
        copperRingRetryView.setVisibility(View.GONE);
        panelTitleView.setVisibility(drawMode ? View.GONE : View.VISIBLE);
        panelBodyView.setVisibility(drawMode ? View.GONE : View.VISIBLE);
        rafflePoolsScrollView.setVisibility(drawMode ? View.VISIBLE : View.GONE);
        alphaMarketplaceScrollView.setVisibility(View.GONE);
        raffleDrawResultView.setVisibility(drawMode
                && !raffleDrawResultView.getText().toString().isEmpty()
                ? View.VISIBLE
                : View.GONE);
        balanceView.setVisibility(profileMode ? View.VISIBLE : View.GONE);
        stepsView.setVisibility(View.GONE);
        acceptedStepsView.setVisibility(View.GONE);
        earnedView.setVisibility(View.GONE);
        raffleView.setVisibility(profileMode ? View.VISIBLE : View.GONE);
        trackingView.setVisibility(View.GONE);
        syncStatusView.setVisibility(View.GONE);
        changeNameView.setVisibility(profileMode ? View.VISIBLE : View.GONE);
        activityHistoryView.setVisibility(profileMode ? View.VISIBLE : View.GONE);
        drawHistoryView.setVisibility(BuildConfig.IS_ALPHA_DEV && profileMode ?
                View.VISIBLE : View.GONE);
        changePasswordView.setVisibility(profileMode ? View.VISIBLE : View.GONE);
        signOutView.setVisibility(profileMode ? View.VISIBLE : View.GONE);
        retryView.setVisibility(View.GONE);
        profileVersionView.setVisibility(profileMode ? View.VISIBLE : View.GONE);
    }

    private void showLoginForm(String message) {
        selectedMode = Mode.PROFILE;
        avatarView.setVisibility(View.GONE);
        headerBalancesView.setVisibility(View.GONE);
        modeTabsView.setVisibility(View.GONE);
        stepStatusBlockView.setVisibility(View.GONE);
        copperRingArtworkView.setVisibility(View.GONE);
        copperRingInventoryView.setVisibility(View.GONE);
        copperRingDetailScrollView.setVisibility(View.GONE);
        copperRingStatusView.setVisibility(View.GONE);
        copperRingRetryView.setVisibility(View.GONE);
        panelTitleView.setVisibility(View.VISIBLE);
        panelBodyView.setVisibility(View.VISIBLE);
        updateModeTabs();
        setRegistrationMode(false);
        usernameInput.setVisibility(View.VISIBLE);
        passwordInput.setVisibility(View.VISIBLE);
        loginButton.setVisibility(View.VISIBLE);
        authModeButton.setVisibility(View.VISIBLE);
        loginMessageView.setVisibility(message == null || message.trim().isEmpty() ? View.GONE : View.VISIBLE);
        loginMessageView.setText(message == null || message.trim().isEmpty() ? "Login: " : "Login: " + message);
        balanceView.setVisibility(View.GONE);
        stepsView.setVisibility(View.GONE);
        acceptedStepsView.setVisibility(View.GONE);
        earnedView.setVisibility(View.GONE);
        raffleView.setVisibility(View.GONE);
        trackingView.setVisibility(View.GONE);
        syncStatusView.setVisibility(View.GONE);
        changeNameView.setVisibility(View.GONE);
        activityHistoryView.setVisibility(View.GONE);
        drawHistoryView.setVisibility(View.GONE);
        changePasswordView.setVisibility(View.GONE);
        signOutView.setVisibility(View.GONE);
        profileVersionView.setVisibility(View.GONE);
        raffleDrawResultView.setVisibility(View.GONE);
        rafflePoolsScrollView.setVisibility(View.GONE);
        alphaMarketplaceScrollView.setVisibility(View.GONE);
        alphaMarketplaceGeneration++;
        retryView.setVisibility(View.GONE);
    }

    private void hideLoginForm() {
        if (usernameInput == null || balanceView == null) {
            return;
        }

        avatarView.setVisibility(View.VISIBLE);
        headerBalancesView.setVisibility(View.VISIBLE);
        if (modeTabsView != null) {
            modeTabsView.setVisibility(View.VISIBLE);
        }
        usernameInput.setVisibility(View.GONE);
        passwordInput.setVisibility(View.GONE);
        registrationDisplayNameInput.setVisibility(View.GONE);
        registrationPasswordConfirmationInput.setVisibility(View.GONE);
        loginButton.setVisibility(View.GONE);
        authModeButton.setVisibility(View.GONE);
        loginMessageView.setVisibility(View.GONE);
        panelTitleView.setVisibility(View.VISIBLE);
        panelBodyView.setVisibility(View.VISIBLE);
        balanceView.setVisibility(View.VISIBLE);
        stepsView.setVisibility(View.VISIBLE);
        acceptedStepsView.setVisibility(View.VISIBLE);
        earnedView.setVisibility(View.VISIBLE);
        raffleView.setVisibility(View.VISIBLE);
        trackingView.setVisibility(View.VISIBLE);
        syncStatusView.setVisibility(View.VISIBLE);
        changeNameView.setVisibility(View.VISIBLE);
        activityHistoryView.setVisibility(View.VISIBLE);
        changePasswordView.setVisibility(View.VISIBLE);
        signOutView.setVisibility(View.VISIBLE);
        raffleDrawResultView.setVisibility(View.GONE);
        rafflePoolsScrollView.setVisibility(View.GONE);
        retryView.setVisibility(View.GONE);
    }

    private void submitLogin() {
        String username = usernameInput.getText().toString();
        String password = passwordInput.getText().toString();
        String passwordConfirmation = registrationPasswordConfirmationInput.getText().toString();
        String displayName = registrationDisplayNameInput.getText().toString();
        boolean registrationRequest = registrationMode;
        loginButton.setEnabled(false);
        authModeButton.setEnabled(false);
        loginButton.setText(registrationRequest ? getString(R.string.creating_account) : "Signing in...");
        loginMessageView.setVisibility(View.VISIBLE);
        loginMessageView.setText(registrationRequest ? "Account: creating" : "Login: submitting");

        new Thread(() -> {
            LoginUiState state = registrationRequest
                    ? loginSessionService.register(username, password, passwordConfirmation, displayName)
                    : loginSessionService.login(username, password);
            runOnUiThread(() -> renderLoginResult(state, registrationRequest));
        }).start();
    }

    private void renderLoginResult(LoginUiState state, boolean registrationRequest) {
        loginButton.setEnabled(true);
        authModeButton.setEnabled(true);
        loginButton.setText(registrationRequest ? getString(R.string.create_account) : "Sign in");
        if (state.isAuthenticated()) {
            passwordInput.setText("");
            registrationPasswordConfirmationInput.setText("");
            registrationDisplayNameInput.setText("");
            registrationMode = false;
            selectedMode = Mode.WALK;
            StepSyncScheduler.scheduleAll(this);
            hideLoginForm();
            loadHomeProfile();
            return;
        }

        loginMessageView.setVisibility(View.VISIBLE);
        loginMessageView.setText((registrationRequest ? "Account: " : "Login: ")
                + (state.errorMessage() == null ? "failed" : state.errorMessage()));
    }

    private void setRegistrationMode(boolean enabled) {
        registrationMode = enabled;
        panelTitleView.setText(enabled ? getString(R.string.create_account) : "Sign in");
        panelTitleView.setTextColor(textColor);
        panelBodyView.setText(enabled
                ? "Create an account to enable automatic step tracking on this installation."
                : "Enter your credentials to load the profile and enable automatic step tracking.");
        panelBodyView.setTextColor(mutedColor);
        registrationDisplayNameInput.setVisibility(enabled ? View.VISIBLE : View.GONE);
        registrationPasswordConfirmationInput.setVisibility(enabled ? View.VISIBLE : View.GONE);
        loginButton.setText(enabled ? getString(R.string.create_account) : "Sign in");
        authModeButton.setText(enabled ? getString(R.string.back_to_sign_in) : getString(R.string.create_account));
        passwordInput.setText("");
        registrationPasswordConfirmationInput.setText("");
        loginMessageView.setVisibility(View.GONE);
    }
    private void updateModeTabs() {
        applyTabState(homeTab, selectedMode == Mode.WALK, false);
        applyTabState(drawTab, selectedMode == Mode.DRAW, false);
        applyTabState(ringsTab, selectedMode == Mode.RINGS, false);
        applyTabState(marketplaceTab, selectedMode == Mode.MARKETPLACE, false);
    }

    private void showActivityHistoryDialog() {
        if (BuildConfig.IS_ALPHA_DEV) {
            if (new AlphaSessionStore(this).verified() == null) return;
        } else if (currentProfile == null) return;
        LinearLayout form = dialogForm();
        LinearLayout tabs = new LinearLayout(this);
        tabs.setId(R.id.profile_activity_tabs);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams tabsParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dimensionPixelSize(R.dimen.touch_target));
        tabsParams.bottomMargin = dimensionPixelSize(R.dimen.space_md);
        tabs.setLayoutParams(tabsParams);

        TextView activityTab = profileActivityTab("Activity", R.id.profile_activity_section);
        TextView drawHistoryTab = profileActivityTab("Draw history", R.id.profile_draw_history_section);
        tabs.addView(activityTab);
        tabs.addView(drawHistoryTab);
        form.addView(tabs);
        if (BuildConfig.IS_ALPHA_DEV) tabs.setVisibility(View.GONE);

        TextView status = dialogMessage();
        form.addView(status);

        ScrollView scroll = new ScrollView(this);
        LinearLayout list = new LinearLayout(this);
        list.setId(R.id.activity_history_list);
        list.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(list, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        scroll.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                SmallScreenLayout.activityDialogListHeightPx(
                        getResources().getDisplayMetrics().heightPixels,
                        getResources().getDisplayMetrics().density
                )
        ));
        form.addView(scroll);

        TextView retry = outlineButton("Retry");
        retry.setVisibility(View.GONE);
        form.addView(retry);

        ProfileActivityDialogState state = new ProfileActivityDialogState(
                activityTab, drawHistoryTab, status, list, retry);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.activity_history)
                .setView(form)
                .setNegativeButton("Close", null)
                .create();
        state.dialog = dialog;
        activityTab.setOnClickListener(view -> selectProfileActivitySection(
                state, ProfileActivitySection.ACTIVITY));
        drawHistoryTab.setOnClickListener(view -> selectProfileActivitySection(
                state, ProfileActivitySection.DRAW_HISTORY));
        dialog.setOnDismissListener(ignored -> state.requestGeneration++);
        dialog.setOnShowListener(ignored -> selectProfileActivitySection(
                state, ProfileActivitySection.ACTIVITY));
        dialog.show();
    }

    private void showAlphaDrawHistory() {
        try {
            Class.forName("xyz.etherings.player.alpha.AlphaDrawPanel")
                    .getMethod("showHistory", android.content.Context.class)
                    .invoke(null, this);
        } catch (Exception error) {
            new AlertDialog.Builder(this).setTitle("Draw history")
                    .setMessage("Draw history is unavailable.")
                    .setPositiveButton("Close", null).show();
        }
    }

    private TextView profileActivityTab(String label, int id) {
        TextView tab = baseTab(label, false, false);
        tab.setId(id);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0, dimensionPixelSize(R.dimen.touch_target), 1f);
        int gap = dimensionPixelSize(R.dimen.space_xs);
        params.setMargins(gap, 0, gap, 0);
        tab.setLayoutParams(params);
        return tab;
    }

    private void selectProfileActivitySection(ProfileActivityDialogState state,
            ProfileActivitySection section) {
        state.selected = section;
        applyTabState(state.activityTab, section == ProfileActivitySection.ACTIVITY, false);
        applyTabState(state.drawHistoryTab, section == ProfileActivitySection.DRAW_HISTORY, false);
        if (section == ProfileActivitySection.ACTIVITY) loadActivityHistory(state);
        else loadProfileDrawHistory(state);
    }

    private int beginProfileActivityLoad(ProfileActivityDialogState state,
            ProfileActivitySection section, String message, View.OnClickListener retryAction) {
        state.status.setText(message);
        state.status.setTextColor(mutedColor);
        state.status.setVisibility(View.VISIBLE);
        state.list.removeAllViews();
        state.retry.setEnabled(false);
        state.retry.setVisibility(View.GONE);
        state.retry.setOnClickListener(retryAction);
        state.selected = section;
        return ++state.requestGeneration;
    }

    private boolean isCurrentProfileActivityRequest(ProfileActivityDialogState state,
            ProfileActivitySection section, int generation) {
        return state.dialog.isShowing() && state.selected == section
                && state.requestGeneration == generation;
    }

    private void loadActivityHistory(ProfileActivityDialogState state) {
        int generation = beginProfileActivityLoad(state, ProfileActivitySection.ACTIVITY,
                "Loading activity...", view -> loadActivityHistory(state));
        new Thread(() -> {
            ActivityHistoryRepository.Result result;
            if (BuildConfig.IS_ALPHA_DEV) {
                try {
                    result = (ActivityHistoryRepository.Result) Class.forName(
                            "xyz.etherings.player.alpha.AlphaActivityHistoryClient")
                            .getMethod("load", android.content.Context.class, LocalDate.class)
                            .invoke(null, this, LocalDate.now());
                } catch (Exception error) {
                    result = ActivityHistoryRepository.Result.error(
                            ActivityHistoryRepository.ErrorKind.ERROR, "Activity is unavailable.");
                }
            } else result = activityHistoryRepository.loadLast30Days(LocalDate.now());
            ActivityHistoryRepository.Result loaded = result;
            runOnUiThread(() -> renderActivityHistory(state, generation, loaded));
        }).start();
    }

    private void renderActivityHistory(ProfileActivityDialogState state, int generation,
            ActivityHistoryRepository.Result result) {
        if (!BuildConfig.IS_ALPHA_DEV && !result.isSuccess()
                && result.errorKind() == ActivityHistoryRepository.ErrorKind.SESSION_EXPIRED) {
            expireProfileActivitySession(state, result.errorMessage());
            return;
        }
        if (!isCurrentProfileActivityRequest(
                state, ProfileActivitySection.ACTIVITY, generation)) return;
        state.retry.setEnabled(true);
        if (result.isSuccess()) {
            if (result.items().isEmpty()) {
                showProfileActivityMessage(state, "No activity recorded in the last 30 days.",
                        mutedColor, false);
                return;
            }
            state.status.setVisibility(View.GONE);
            for (DailyActivityItem item : result.items()) {
                state.list.addView(activityHistoryRow(item));
            }
            return;
        }
        showProfileActivityMessage(state, result.errorMessage(),
                result.errorKind() == ActivityHistoryRepository.ErrorKind.BACKEND_OFFLINE
                        ? mutedColor : errorColor, true);
    }

    private void loadProfileDrawHistory(ProfileActivityDialogState state) {
        int generation = beginProfileActivityLoad(state, ProfileActivitySection.DRAW_HISTORY,
                "Loading draw history...", view -> loadProfileDrawHistory(state));
        new Thread(() -> {
            RaffleV2ReadRepository.Result<RaffleV2HistoryPage> result =
                    raffleV2ReadRepository.loadHistory(30, null);
            runOnUiThread(() -> renderProfileDrawHistory(state, generation, result));
        }).start();
    }

    private void renderProfileDrawHistory(ProfileActivityDialogState state, int generation,
            RaffleV2ReadRepository.Result<RaffleV2HistoryPage> result) {
        if (!result.isSuccess()
                && result.errorKind() == RaffleV2ReadRepository.ErrorKind.SESSION_EXPIRED) {
            expireProfileActivitySession(state, result.errorMessage());
            return;
        }
        if (!isCurrentProfileActivityRequest(
                state, ProfileActivitySection.DRAW_HISTORY, generation)) return;
        state.retry.setEnabled(true);
        if (!result.isSuccess()) {
            showProfileActivityMessage(state, result.errorMessage(), errorColor, true);
            return;
        }
        if (result.value().itemSnapshots().isEmpty()) {
            showProfileActivityMessage(state, "No draw history yet.", mutedColor, false);
            return;
        }
        state.status.setVisibility(View.GONE);
        for (String snapshot : result.value().itemSnapshots()) {
            state.list.addView(raffleHistoryItemView(snapshot));
        }
    }

    private void showProfileActivityMessage(ProfileActivityDialogState state,
            String message, int color, boolean retryable) {
        state.list.removeAllViews();
        state.status.setText(message);
        state.status.setTextColor(color);
        state.status.setVisibility(View.VISIBLE);
        state.retry.setVisibility(retryable ? View.VISIBLE : View.GONE);
    }

    private void expireProfileActivitySession(ProfileActivityDialogState state, String message) {
        if (currentProfile == null || isFinishing() || isDestroyed()) return;
        state.dialog.dismiss();
        clearProfileUiState();
        showLoginForm(message);
    }

    private TextView activityHistoryRow(DailyActivityItem item) {
        TextView row = new TextView(this);
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("d MMM uuuu", Locale.ENGLISH);
        String raffleLabel = item.raffleAttempts() == 1 ? "draw" : "draws";
        row.setText(item.date().format(formatter)
                + "\n" + item.acceptedSteps() + " / " +
                (item.stepCap() == null ? "--" : item.stepCap()) + " steps   "
                + item.earnedErtDisplay() + " ERT"
                + (BuildConfig.IS_ALPHA_DEV ? "" : "\n" + item.raffleAttempts() + " " + raffleLabel));
        row.setTextColor(textColor);
        setTokenTextSize(row, R.dimen.text_body);
        row.setPadding(
                dimensionPixelSize(R.dimen.space_md),
                dimensionPixelSize(R.dimen.space_sm),
                dimensionPixelSize(R.dimen.space_md),
                dimensionPixelSize(R.dimen.space_sm)
        );
        row.setBackground(new BorderDrawable(
                outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_control),
                elevatedPanelColor
        ));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dimensionPixelSize(R.dimen.space_sm);
        row.setLayoutParams(params);
        return row;
    }

    private void showChangeNameDialog() {
        if (currentProfile == null) return;
        LinearLayout form = dialogForm();
        EditText nameInput = textInput("Display name", false);
        nameInput.setText(currentProfile.displayName());
        nameInput.setSelection(nameInput.getText().length());
        TextView errorView = dialogMessage();
        form.addView(nameInput);
        form.addView(errorView);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Change name")
                .setView(form)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save", null)
                .create();
        dialog.setOnShowListener(ignored -> {
            Button save = dialog.getButton(DialogInterface.BUTTON_POSITIVE);
            save.setOnClickListener(view -> {
                String displayName = nameInput.getText().toString();
                save.setEnabled(false);
                errorView.setText(R.string.saving);
                errorView.setVisibility(View.VISIBLE);
                new Thread(() -> {
                    ProfileManagementService.Result result = profileManagementService.updateDisplayName(
                            displayName
                    );
                    runOnUiThread(() -> renderNameChange(dialog, save, errorView, result));
                }).start();
            });
        });
        dialog.show();
    }

    private void renderNameChange(
            AlertDialog dialog,
            Button save,
            TextView errorView,
            ProfileManagementService.Result result
    ) {
        if (result.isSuccess()) {
            currentProfile = result.profile();
            stepDisplaySnapshotStore.saveServerDailyStepCap(
                    currentProfile.userId(), currentProfile.dailyStepCap()
            );
            currentProfileStale = false;
            currentServerValuesKnown = true;
            dialog.dismiss();
            renderSelectedMode();
            return;
        }
        if (result.errorKind() == ProfileManagementService.ErrorKind.SESSION_EXPIRED) {
            dialog.dismiss();
            clearProfileUiState();
            showLoginForm(result.message());
            return;
        }
        save.setEnabled(true);
        errorView.setText(result.message());
        errorView.setTextColor(errorColor);
    }

    private void showChangePasswordDialog() {
        if (currentProfile == null) return;
        LinearLayout form = dialogForm();
        EditText currentInput = textInput("Current password", true);
        EditText newInput = textInput("New password", true);
        EditText confirmationInput = textInput("Confirm new password", true);
        TextView errorView = dialogMessage();
        form.addView(currentInput);
        form.addView(newInput);
        form.addView(confirmationInput);
        form.addView(errorView);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Change password")
                .setView(form)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Change", null)
                .create();
        dialog.setOnShowListener(ignored -> {
            Button change = dialog.getButton(DialogInterface.BUTTON_POSITIVE);
            change.setOnClickListener(view -> {
                String currentPassword = currentInput.getText().toString();
                String newPassword = newInput.getText().toString();
                String confirmation = confirmationInput.getText().toString();
                change.setEnabled(false);
                errorView.setText(R.string.changing_password);
                errorView.setVisibility(View.VISIBLE);
                new Thread(() -> {
                    ProfileManagementService.Result result = profileManagementService.changePassword(
                            currentPassword,
                            newPassword,
                            confirmation
                    );
                    runOnUiThread(() -> renderPasswordChange(dialog, change, errorView, result));
                }).start();
            });
        });
        dialog.show();
    }

    private void renderPasswordChange(
            AlertDialog dialog,
            Button change,
            TextView errorView,
            ProfileManagementService.Result result
    ) {
        if (result.isPasswordChanged()) {
            dialog.dismiss();
            clearProfileUiState();
            showLoginForm(result.message());
            return;
        }
        if (result.errorKind() == ProfileManagementService.ErrorKind.SESSION_EXPIRED) {
            dialog.dismiss();
            clearProfileUiState();
            showLoginForm(result.message());
            return;
        }
        change.setEnabled(true);
        errorView.setText(result.message());
        errorView.setTextColor(errorColor);
    }

    private LinearLayout dialogForm() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int inset = dimensionPixelSize(R.dimen.space_lg);
        form.setPadding(inset, dimensionPixelSize(R.dimen.space_sm), inset, 0);
        return form;
    }

    private TextView dialogMessage() {
        TextView message = new TextView(this);
        message.setTextColor(mutedColor);
        setTokenTextSize(message, R.dimen.text_label);
        message.setPadding(0, dimensionPixelSize(R.dimen.space_sm), 0, 0);
        message.setVisibility(View.GONE);
        return message;
    }

    private void submitLogout() {
        signOutView.setEnabled(false);
        signOutView.setText(R.string.signing_out);
        new Thread(() -> {
            loginSessionService.logout();
            runOnUiThread(() -> {
                signOutView.setEnabled(true);
                signOutView.setText(R.string.sign_out);
                clearProfileUiState();
                showLoginForm("Signed out");
            });
        }).start();
    }

    private String modeTitle(Mode mode, String displayName) {
        if (mode == Mode.DRAW) {
            return "Draw";
        }
        if (mode == Mode.PROFILE) {
            return displayName;
        }
        if (mode == Mode.RINGS) {
            return "Ring inventory";
        }
        return "Move to Earn";
    }

    private String modeBody(Mode mode) {
        if (mode == Mode.DRAW) {
            return drawModeBody();
        }
        if (mode == Mode.PROFILE) {
            return currentProfileStale
                    ? "Saved profile. Server data is currently unavailable."
                    : "Profile, balances, and session details for the signed-in player.";
        }
        if (mode == Mode.RINGS) {
            return "Your Cooper game rings.";
        }
        return "Steps are tracked automatically and delivered for ERT rewards.";
    }

    private String drawModeBody() {
        return "";
    }

    private String trackingStatusMessage() {
        if (currentProfileStale) {
            return stepTrackingState.message() + " | server data offline";
        }
        return stepTrackingState.message();
    }

    private void clearProfileUiState() {
        if (raffleRewardDialog != null) raffleRewardDialog.dismiss();
        currentProfile = null;
        currentProfileStale = false;
        currentServerValuesKnown = false;
        silentProfileRefreshInFlight = false;
        raffleCurrentLoading = false;
        raffleCurrentLoaded = false;
        raffleDrawInFlight = false;
        currentRaffleDraw = null;
        raffleRequestGeneration++;
        copperRingRequestGeneration++;
        copperRingUiState = null;
        copperRingOwnerId = null;
        copperRingDetailId = null;
        copperRingDetailReturnMode = Mode.WALK;
        copperLevelUpInFlight = false;
        copperAllocationInFlight = false;
        copperEquipmentInFlight = false;
        pendingLevelUp.clear();
        pendingAllocation.clear();
        pendingEquipment.clear();
        copperAttributeDraftRingId = null;
        copperAttributeDraft = null;
        mainHandler.removeCallbacks(staleProfileRetry);
        resetHeaderBalances();
        panelTitleView.setText("Sign in required");
        panelTitleView.setTextColor(textColor);
        panelBodyView.setText("Enter your credentials to load the profile and enable automatic step tracking.");
        panelBodyView.setTextColor(mutedColor);
        balanceView.setText("ERT balance: --");
        stepsView.setText("On this phone today: --");
        acceptedStepsView.setText("Accepted by server today: --");
        earnedView.setText("ERT earned today: --");
        raffleView.setText("Draws today: --");
        trackingView.setText("Current reward window: --");
        syncStatusView.setText("Delivery: --");
        raffleDrawResultView.setText("");
        rafflePoolsContainer.removeAllViews();
    }

    private String errorTitle(HomeRepository.ErrorKind errorKind) {
        if (errorKind == HomeRepository.ErrorKind.UNAUTHENTICATED) {
            return "Sign in required";
        }
        if (errorKind == HomeRepository.ErrorKind.SESSION_EXPIRED) {
            return "Session expired";
        }
        if (errorKind == HomeRepository.ErrorKind.BACKEND_OFFLINE) {
            return "Backend offline";
        }
        return "Home unavailable";
    }

    private TextView modeTab(String label, Mode mode, boolean disabled) {
        TextView tab = baseTab(label, selectedMode == mode, disabled);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0,
                dimensionPixelSize(R.dimen.touch_target),
                1f
        );
        params.setMargins(
                dimensionPixelSize(R.dimen.space_xs),
                0,
                dimensionPixelSize(R.dimen.space_xs),
                0
        );
        tab.setLayoutParams(params);
        tab.setOnClickListener(view -> selectMode(mode));
        return tab;
    }

    private TextView baseTab(String label, boolean selected, boolean disabled) {
        TextView tab = new TextView(this);
        tab.setText(label);
        tab.setGravity(Gravity.CENTER);
        setTokenTextSize(tab, R.dimen.text_label);
        tab.setSingleLine(true);
        tab.setPadding(
                dimensionPixelSize(R.dimen.space_xs),
                0,
                dimensionPixelSize(R.dimen.space_xs),
                0
        );
        applyTabState(tab, selected, disabled);
        return tab;
    }

    private void applyTabState(TextView tab, boolean selected, boolean disabled) {
        if (tab == null) {
            return;
        }

        tab.setEnabled(!disabled);
        tab.setTextColor(disabled ? disabledTextColor : selected ? onAccentColor : textColor);
        tab.setBackground(new BorderDrawable(
                disabled ? outlineColor : selected ? accentColor : outlineColor,
                dimension(R.dimen.border_standard),
                dimension(R.dimen.radius_control),
                disabled ? disabledFillColor : selected ? accentColor : panelColor
        ));
    }

    private ViewGroup.LayoutParams matchParent() {
        return new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private float dimension(int resourceId) {
        return getResources().getDimension(resourceId);
    }

    private int dimensionPixelSize(int resourceId) {
        return getResources().getDimensionPixelSize(resourceId);
    }

    private void setTokenTextSize(TextView view, int resourceId) {
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, dimension(resourceId));
    }
}
