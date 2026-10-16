export type Fix = {
  lat: number;
  lng: number;
  accuracy: number;
};

export function watchRoom(onFix: (fix: Fix) => void, onOff: () => void) {
  if (!navigator.geolocation) {
    onOff();
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (position) => {
      onFix({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
    },
    () => onOff(),
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export function currentFix(): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 },
    );
  });
}

type Scan = { stop: () => void };
type AdvertisementEvent = Event & { rssi?: number };
type BluetoothWithScan = {
  requestLEScan?: (options: { acceptAllAdvertisements: boolean }) => Promise<Scan>;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
};

function bluetoothApi() {
  if (typeof navigator === "undefined" || !("bluetooth" in navigator)) return undefined;
  return (navigator as Navigator & { bluetooth?: BluetoothWithScan }).bluetooth;
}

export function bleScanSupported() {
  return typeof bluetoothApi()?.requestLEScan === "function";
}

export async function listenForRssi(onRssi: (rssi: number) => void) {
  const bluetooth = bluetoothApi();
  if (!bluetooth?.requestLEScan) {
    throw new Error("This browser cannot scan Bluetooth. Room location is used instead.");
  }
  const scan = await bluetooth.requestLEScan({ acceptAllAdvertisements: true });
  const handler = (event: Event) => {
    const rssi = (event as AdvertisementEvent).rssi;
    if (typeof rssi === "number") onRssi(rssi);
  };
  bluetooth.addEventListener("advertisementreceived", handler);
  return () => {
    scan.stop();
    bluetooth.removeEventListener("advertisementreceived", handler);
  };
}
