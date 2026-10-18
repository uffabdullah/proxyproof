package com.proxyproof.ble;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(
    name = "ProxyProofBle",
    permissions = {
        @Permission(strings = {
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.ACCESS_FINE_LOCATION
        }, alias = "bluetooth"),
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "location"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class ProxyProofBlePlugin extends Plugin {
    static final UUID SERVICE = UUID.fromString("0000f0f0-0000-1000-8000-00805f9b34fb");
    private static final Pattern AIR = Pattern.compile("PP[0-9A-F]{16}");
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private PluginCall pending;
    private PluginCall advertiseCall;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void prepare(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) {
            requestPermissionForAlias("bluetooth", call, "prepareCallback");
            return;
        }
        if (Build.VERSION.SDK_INT < 31 && getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "prepareCallback");
            return;
        }
        askNotesOrFinish(call);
    }

    @PermissionCallback
    private void prepareCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("Bluetooth permission is required.");
            return;
        }
        if (Build.VERSION.SDK_INT < 31 && getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Location permission is required for Bluetooth scanning.");
            return;
        }
        askNotesOrFinish(call);
    }

    private void askNotesOrFinish(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notesCallback");
            return;
        }
        finishPrepare(call);
    }

    @PermissionCallback
    private void notesCallback(PluginCall call) {
        finishPrepare(call);
    }

    private void finishPrepare(PluginCall call) {
        showReady();
        JSObject ret = new JSObject();
        BluetoothAdapter adapter = adapter();
        ret.put("bluetooth", adapter != null && adapter.isEnabled());
        ret.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void shareCsv(PluginCall call) {
        String rawName = call.getString("filename", "attendance.csv");
        String csv = call.getString("csv");
        if (csv == null) {
            call.reject("Nothing to export.");
            return;
        }
        String filename = rawName.replaceAll("[^A-Za-z0-9._-]", "-");
        if (!filename.endsWith(".csv")) filename = filename + ".csv";
        try {
            File dir = new File(getContext().getCacheDir(), "exports");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("Could not create the export folder.");
                return;
            }
            File file = new File(dir, filename);
            FileOutputStream out = new FileOutputStream(file);
            out.write(csv.getBytes(StandardCharsets.UTF_8));
            out.close();
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/csv");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Export CSV");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "The CSV could not be exported." : error.getMessage());
        }
    }

    private void showReady() {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) return;
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String channelId = "proxyproof";
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(channelId, "Attendance", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(getContext(), channelId)
            : new Notification.Builder(getContext());
        manager.notify(4101, builder
            .setContentTitle("ProxyProof")
            .setContentText("Bluetooth attendance is ready.")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .build());
    }

    @PluginMethod
    public void alert(PluginCall call) {
        String title = call.getString("title", "ProxyProof");
        String body = call.getString("body", "");
        int id = call.getInt("id", 4104);
        Long until = call.getLong("until");
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            call.reject("Notifications are unavailable.");
            return;
        }
        boolean countdown = until != null && until > 0;
        String channelId = countdown ? "proxyproof-alerts" : "proxyproof";
        if (Build.VERSION.SDK_INT >= 26) {
            int importance = countdown ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_DEFAULT;
            manager.createNotificationChannel(new NotificationChannel(channelId, countdown ? "Attendance alerts" : "Attendance", importance));
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(getContext(), channelId)
            : new Notification.Builder(getContext());
        builder.setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setAutoCancel(!countdown);
        if (countdown) {
            builder.setWhen(until);
            builder.setUsesChronometer(true);
            builder.setOngoing(true);
            if (Build.VERSION.SDK_INT >= 24) builder.setChronometerCountDown(true);
        }
        manager.notify(id, builder.build());
        call.resolve();
    }

    @PluginMethod
    public void clearAlert(PluginCall call) {
        int id = call.getInt("id", 4103);
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(id);
        call.resolve();
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        if (!ensure(call)) return;
        pending = null;
        String payload = call.getString("payload");
        if (payload == null) payload = "";
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled() || adapter.getBluetoothLeAdvertiser() == null) {
            call.reject("Turn Bluetooth on, then start the session again.");
            return;
        }
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiseCall != null) {
            advertiseCall.resolve();
            advertiseCall = null;
        }
        handler.removeCallbacks(advertiseTimeout);
        advertiseCall = call;
        advertiser.stopAdvertising(advertiseCallback);
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceData(new ParcelUuid(SERVICE), payload.getBytes(StandardCharsets.UTF_8))
            .build();
        handler.post(() -> {
            if (advertiseCall != call || advertiser == null) return;
            advertiser.startAdvertising(settings, data, advertiseCallback);
            handler.postDelayed(advertiseTimeout, 1500);
        });
    }

    @PluginMethod
    public void stopAdvertising(PluginCall call) {
        if (advertiser != null) advertiser.stopAdvertising(advertiseCallback);
        call.resolve();
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        if (!ensure(call)) return;
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled() || adapter.getBluetoothLeScanner() == null) {
            call.reject("Turn Bluetooth on, then open this screen again.");
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();
        scanner.startScan(null, settings, scanCallback);
        call.resolve();
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        if (scanner != null) scanner.stopScan(scanCallback);
        call.resolve();
    }

    private boolean ensure(PluginCall call) {
        if (Build.VERSION.SDK_INT < 31) return true;
        if (getPermissionState("bluetooth") == PermissionState.GRANTED) return true;
        pending = call;
        requestPermissionForAlias("bluetooth", call, "permsCallback");
        return false;
    }

    @PermissionCallback
    private void permsCallback(PluginCall call) {
        if (getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("Bluetooth permission is required.");
            return;
        }
        String payload = call.getString("payload");
        if (payload != null) startAdvertising(call);
        else startScan(call);
    }

    private BluetoothAdapter adapter() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(android.content.Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private final Runnable advertiseTimeout = () -> {
        if (advertiseCall != null) {
            advertiseCall.reject("Bluetooth did not start advertising.");
            advertiseCall = null;
        }
    };

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            handler.removeCallbacks(advertiseTimeout);
            if (advertiseCall != null) {
                advertiseCall.resolve();
                advertiseCall = null;
            }
        }

        @Override
        public void onStartFailure(int errorCode) {
            handler.removeCallbacks(advertiseTimeout);
            if (advertiseCall == null) return;
            if (errorCode == AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED) advertiseCall.resolve();
            else advertiseCall.reject(advertiseFailure(errorCode));
            advertiseCall = null;
        }
    };

    private String advertiseFailure(int code) {
        if (code == AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE) return "The Bluetooth beacon is too large for this phone.";
        if (code == AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS) return "This phone is already broadcasting too many Bluetooth beacons.";
        if (code == AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED) return "This phone cannot broadcast Bluetooth beacons.";
        return "Bluetooth advertising failed (" + code + ").";
    }

    private String payloadFrom(android.bluetooth.le.ScanRecord record) {
        if (record == null) return null;
        byte[] bytes = record.getServiceData(new ParcelUuid(SERVICE));
        if (bytes != null) return new String(bytes, StandardCharsets.UTF_8);
        byte[] raw = record.getBytes();
        if (raw == null) return null;
        Matcher match = AIR.matcher(new String(raw, StandardCharsets.ISO_8859_1).toUpperCase());
        return match.find() ? match.group() : null;
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            if (result == null) return;
            String payload = payloadFrom(result.getScanRecord());
            if (payload == null) return;
            JSObject data = new JSObject();
            data.put("payload", payload);
            data.put("rssi", result.getRssi());
            notifyListeners("beacon", data);
        }
    };
}
