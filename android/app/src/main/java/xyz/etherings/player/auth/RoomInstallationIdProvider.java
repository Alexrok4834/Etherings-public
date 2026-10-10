package xyz.etherings.player.auth;

import android.content.Context;

import xyz.etherings.player.step.StepRoomBootstrapper;
import xyz.etherings.player.sync.EtheringsDatabase;

public final class RoomInstallationIdProvider implements InstallationIdProvider {
    private final Context context;

    public RoomInstallationIdProvider(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    public String installationId() {
        EtheringsDatabase database = EtheringsDatabase.open(context);
        return StepRoomBootstrapper.bootstrap(context, database, System.currentTimeMillis()).installationId();
    }
}
