package xyz.etherings.player.update;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import java.util.Locale;

import xyz.etherings.player.BuildConfig;

/** Checks the current release on every foreground entry; no cached result can hide a new APK. */
public final class AppUpdateNotice {
    private final Activity activity;
    private long generation;
    private boolean started;
    private AlertDialog dialog;

    public AppUpdateNotice(Activity activity) {
        this.activity = activity;
    }

    public void onStart() {
        started = true;
        long request = ++generation;
        new Thread(() -> {
            AppRelease release;
            try {
                release = new AppReleaseClient().fetch();
            } catch (Exception ignored) {
                return;
            }
            activity.runOnUiThread(() -> {
                if (!started || request != generation || activity.isFinishing() ||
                        activity.isDestroyed() || dialog != null ||
                        !release.isNewerThan(BuildConfig.VERSION_CODE)) return;
                double sizeMiB = release.sizeBytes() / (1024d * 1024d);
                String message = "EtheRings " + release.displayVersion() + " is available (" +
                        String.format(Locale.US, "%.1f", sizeMiB) + " MiB)." +
                        (release.required() ? " This update is marked as required." : "");
                AlertDialog candidate = new AlertDialog.Builder(activity)
                        .setTitle(release.required() ? "Update required" : "Update available")
                        .setMessage(message)
                        .setNegativeButton("Later", null)
                        .setPositiveButton("Download", (ignored, which) -> openDownload(release))
                        .create();
                candidate.setOnDismissListener(ignored -> {
                    if (dialog == candidate) dialog = null;
                });
                dialog = candidate;
                candidate.show();
            });
        }, "alpha-release-check").start();
    }

    public void onStop() {
        started = false;
        generation++;
        AlertDialog shown = dialog;
        dialog = null;
        if (shown != null) shown.dismiss();
    }

    private void openDownload(AppRelease release) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(release.downloadUrl())));
        } catch (ActivityNotFoundException error) {
            new AlertDialog.Builder(activity)
                    .setTitle("Download unavailable")
                    .setMessage("No browser is available to open the update download.")
                    .setPositiveButton("OK", null)
                    .show();
        }
    }
}
