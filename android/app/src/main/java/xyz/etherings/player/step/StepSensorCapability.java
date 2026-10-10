package xyz.etherings.player.step;

import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.os.Build;

public final class StepSensorCapability {
    private final boolean stepCounterSupported;
    private final boolean activityRecognitionPermissionRequired;
    private final String sensorName;
    private final String sensorVendor;
    private final int sensorVersion;

    private StepSensorCapability(
            boolean stepCounterSupported,
            boolean activityRecognitionPermissionRequired,
            String sensorName,
            String sensorVendor,
            int sensorVersion
    ) {
        this.stepCounterSupported = stepCounterSupported;
        this.activityRecognitionPermissionRequired = activityRecognitionPermissionRequired;
        this.sensorName = sensorName == null ? "" : sensorName;
        this.sensorVendor = sensorVendor == null ? "" : sensorVendor;
        this.sensorVersion = sensorVersion;
    }

    public static StepSensorCapability detect(Context context) {
        SensorManager sensorManager = (SensorManager) context.getApplicationContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor stepCounter = sensorManager == null ? null : sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        boolean featureDeclared = context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_SENSOR_STEP_COUNTER);
        boolean supported = stepCounter != null || featureDeclared;

        return new StepSensorCapability(
                supported,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q,
                stepCounter == null ? "" : stepCounter.getName(),
                stepCounter == null ? "" : stepCounter.getVendor(),
                stepCounter == null ? 0 : stepCounter.getVersion()
        );
    }

    public boolean isStepCounterSupported() {
        return stepCounterSupported;
    }

    public boolean isActivityRecognitionPermissionRequired() {
        return activityRecognitionPermissionRequired;
    }

    public String sensorName() {
        return sensorName;
    }

    public String sensorVendor() {
        return sensorVendor;
    }

    public int sensorVersion() {
        return sensorVersion;
    }

    public String statusText() {
        if (!stepCounterSupported) {
            return "Native step counter unsupported on this device";
        }

        if (activityRecognitionPermissionRequired) {
            return "Native step counter detected; activity permission required";
        }

        return "Native step counter detected";
    }
}