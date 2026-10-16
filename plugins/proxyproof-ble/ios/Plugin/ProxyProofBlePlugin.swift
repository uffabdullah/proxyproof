import Foundation
import Capacitor
import CoreBluetooth

@objc(ProxyProofBlePlugin)
public class ProxyProofBlePlugin: CAPPlugin, CBPeripheralManagerDelegate, CBCentralManagerDelegate {
    let service = CBUUID(string: "f0f0c0de-7a3b-4d1e-9c8a-6b5d4e3f2a10")
    var peripheral: CBPeripheralManager?
    var central: CBCentralManager?
    var payload = Data()
    var pendingAdvertise: CAPPluginCall?
    var pendingScan: CAPPluginCall?

    @objc func startAdvertising(_ call: CAPPluginCall) {
        payload = (call.getString("payload") ?? "").data(using: .utf8) ?? Data()
        pendingAdvertise = call
        if peripheral == nil {
            peripheral = CBPeripheralManager(delegate: self, queue: nil)
        } else if peripheral?.state == .poweredOn {
            beginAdvertise(call)
        }
    }

    @objc func stopAdvertising(_ call: CAPPluginCall) {
        peripheral?.stopAdvertising()
        call.resolve()
    }

    @objc func startScan(_ call: CAPPluginCall) {
        pendingScan = call
        if central == nil {
            central = CBCentralManager(delegate: self, queue: nil)
        } else if central?.state == .poweredOn {
            beginScan(call)
        }
    }

    @objc func stopScan(_ call: CAPPluginCall) {
        central?.stopScan()
        call.resolve()
    }

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state == .poweredOn, let call = pendingAdvertise else { return }
        beginAdvertise(call)
        pendingAdvertise = nil
    }

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn, let call = pendingScan else { return }
        beginScan(call)
        pendingScan = nil
    }

    func beginAdvertise(_ call: CAPPluginCall) {
        peripheral?.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [service],
            CBAdvertisementDataLocalNameKey: String(data: payload, encoding: .utf8) ?? "",
            CBAdvertisementDataServiceDataKey: [service: payload]
        ])
        call.resolve()
    }

    func beginScan(_ call: CAPPluginCall) {
        central?.scanForPeripherals(withServices: [service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        call.resolve()
    }

    public func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        var text = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? ""
        if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
           let data = serviceData[service],
           let decoded = String(data: data, encoding: .utf8) {
            text = decoded
        }
        notifyListeners("beacon", data: ["payload": text, "rssi": RSSI.intValue])
    }
}
