package xyz.etherings.player.step;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.AlphaSessionStore;
import xyz.etherings.player.auth.SessionStore;

public final class StepTrackingRecovery {
    private StepTrackingRecovery() {
    }

    public static boolean startIfEligible(Context context) {
        Context appContext = context.getApplicationContext();
        if (!isEligible(appContext)) {
            return false;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            appContext.startForegroundService(StepForegroundService.startIntent(appContext));
        } else {
            appContext.startService(StepForegroundService.startIntent(appContext));
        }
        return true;
    }

    public static boolean isEligible(Context context) {
        Context appContext = context.getApplicationContext();
        if (BuildConfig.IS_ALPHA_DEV) {
            if (new AlphaSessionStore(appContext).verified() == null) return false;
        } else {
            SessionStore sessionStore = new SessionStore(appContext);
            if (!sessionStore.hasAccessToken() || !sessionStore.hasOwnerId()) return false;
        }

        StepSensorCapability capability = StepSensorCapability.detect(appContext);
        return capability.isStepCounterSupported() && hasRequiredPermissions(appContext);
    }

    private static boolean hasRequiredPermissions(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }

        return Build.VERSION.SDK_INT < 33
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }
}
