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
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;
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

@CapacitorPlugin(
    name = "ProxyProofBle",
    permissions = {
        @Permission(strings = {
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.ACCESS_FINE_LOCATION
        }, alias = "bluetooth")
    }
)
public class ProxyProofBlePlugin extends Plugin {
    static final UUID SERVICE = UUID.fromString("f0f0c0de-7a3b-4d1e-9c8a-6b5d4e3f2a10");
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private PluginCall pending;

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        if (!ensure(call)) return;
        pending = null;
        String payload = call.getString("payload");
        if (payload == null) payload = "";
        BluetoothAdapter adapter = adapter();
        if (adapter == null || adapter.getBluetoothLeAdvertiser() == null) {
            call.reject("This phone cannot broadcast Bluetooth.");
            return;
        }
        advertiser = adapter.getBluetoothLeAdvertiser();
        advertiser.stopAdvertising(advertiseCallback);
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .addServiceUuid(new ParcelUuid(SERVICE))
            .addServiceData(new ParcelUuid(SERVICE), payload.getBytes(StandardCharsets.UTF_8))
            .build();
        advertiser.startAdvertising(settings, data, advertiseCallback);
        call.resolve();
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
        if (adapter == null || adapter.getBluetoothLeScanner() == null) {
            call.reject("This phone cannot hear Bluetooth.");
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

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {};

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            if (result == null || result.getScanRecord() == null) return;
            byte[] bytes = result.getScanRecord().getServiceData(new ParcelUuid(SERVICE));
            if (bytes == null) return;
            JSObject data = new JSObject();
            data.put("payload", new String(bytes, StandardCharsets.UTF_8));
            data.put("rssi", result.getRssi());
            notifyListeners("beacon", data);
        }
    };
}
