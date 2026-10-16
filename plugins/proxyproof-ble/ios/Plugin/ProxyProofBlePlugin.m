#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(ProxyProofBlePlugin, "ProxyProofBle",
    CAP_PLUGIN_METHOD(startAdvertising, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopAdvertising, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(startScan, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopScan, CAPPluginReturnPromise);
)
