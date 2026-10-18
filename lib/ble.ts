// The website keeps using room location. The Android app turns Bluetooth on.

export const BLE_SERVICE_UUID = "0000f0f0-0000-1000-8000-00805f9b34fb";
export const RSSI_IN_ROOM = -70;

export type HeardBeacon = {
  sessionPrefix: string;
  token: string;
  rssi: number;
  at: number;
};

type NativeBeacon = { name?: string; payload?: string; rssi?: number };
type NativeBle = {
  startAdvertising: (options: { payload: string }) => Promise<void>;
  stopAdvertising: () => Promise<void>;
  startScan: () => Promise<void>;
  stopScan: () => Promise<void>;
  addListener: (
    event: "beacon",
    handler: (data: NativeBeacon) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
};

type WebAdvertiser = { stop: () => void };
type WebBluetooth = {
  advertise?: (options: { name?: string; serviceData?: Array<{ uuid: string; data: BufferSource }> }) => Promise<WebAdvertiser>;
  requestLEScan?: (options: {
    acceptAllAdvertisements?: boolean;
    keepRepeatedDevices?: boolean;
    filters?: Array<{ services?: string[]; namePrefix?: string }>;
  }) => Promise<{ stop: () => void }>;
  getAvailability?: () => Promise<boolean>;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
};

let advertised = "";
let webAdvert: WebAdvertiser | null = null;

export function airName(sessionId: string, token: string) {
  const prefix = sessionId.replace(/-/g, "").slice(0, 8);
  const air = token.slice(0, 8);
  return `PP${prefix}${air}`.toUpperCase();
}

export function parseAirName(value: string | undefined | null) {
  if (!value) return null;
  const match = /PP([0-9A-F]{8})([0-9A-F]{8})/i.exec(value);
  if (!match) return null;
  return { sessionPrefix: match[1].toLowerCase(), token: match[2].toLowerCase() };
}

function bluetooth() {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { bluetooth?: WebBluetooth }).bluetooth;
}

export async function inNativeApp() {
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function nativePlugin() {
  try {
    const { Capacitor, registerPlugin } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return null;
    return registerPlugin<NativeBle>("ProxyProofBle");
  } catch {
    return null;
  }
}

export async function canAdvertise() {
  if (await nativePlugin()) return true;
  return typeof bluetooth()?.advertise === "function";
}

export async function canScan() {
  if (await nativePlugin()) return true;
  const ble = bluetooth();
  return typeof ble?.requestLEScan === "function" || typeof ble?.getAvailability === "function";
}

export async function advertiseBeacon(sessionId: string, token: string) {
  const payload = airName(sessionId, token);
  const native = await nativePlugin();
  if (native) {
    if (payload === advertised) return;
    await native.startAdvertising({ payload });
    advertised = payload;
    return;
  }
  if (payload === advertised && webAdvert) return;
  advertised = payload;
  const ble = bluetooth();
  if (!ble?.advertise) {
    throw new Error("This browser cannot broadcast Bluetooth. Open ProxyProof in the Android or iOS app.");
  }
  webAdvert?.stop();
  const bytes = new TextEncoder().encode(payload);
  webAdvert = await ble.advertise({
    name: payload,
    serviceData: [{ uuid: BLE_SERVICE_UUID, data: bytes }],
  });
}

export async function stopBeacon() {
  advertised = "";
  webAdvert?.stop();
  webAdvert = null;
  const native = await nativePlugin();
  if (native) await native.stopAdvertising().catch(() => undefined);
}

function emitPayload(raw: string | undefined, rssi: number | undefined, onBeacon: (beacon: HeardBeacon) => void) {
  const parsed = parseAirName(raw);
  if (!parsed || typeof rssi !== "number") return;
  onBeacon({ ...parsed, rssi, at: Date.now() });
}

export async function listenForBeacons(onBeacon: (beacon: HeardBeacon) => void) {
  const native = await nativePlugin();
  if (native) {
    const handle = await native.addListener("beacon", (data) => {
      emitPayload(data.payload || data.name, data.rssi, onBeacon);
    });
    await native.startScan();
    return async () => {
      await native.stopScan().catch(() => undefined);
      await handle.remove();
    };
  }

  const ble = bluetooth();
  if (!ble?.requestLEScan) {
    throw new Error("This browser cannot hear Bluetooth beacons. Open ProxyProof in the Android or iOS app.");
  }

  const onEvent = (event: Event) => {
    const advert = event as Event & {
      rssi?: number;
      name?: string;
      serviceData?: Map<string, DataView>;
      manufacturerData?: Map<number, DataView>;
    };
    emitPayload(advert.name, advert.rssi, onBeacon);
    advert.serviceData?.forEach((view) => emitPayload(decodeView(view), advert.rssi, onBeacon));
    advert.manufacturerData?.forEach((view) => emitPayload(decodeView(view), advert.rssi, onBeacon));
  };

  ble.addEventListener("advertisementreceived", onEvent);
  const scan = await ble.requestLEScan({
    keepRepeatedDevices: true,
    acceptAllAdvertisements: true,
  });
  return () => {
    scan.stop();
    ble.removeEventListener("advertisementreceived", onEvent);
  };
}

function decodeView(view: DataView) {
  return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}
