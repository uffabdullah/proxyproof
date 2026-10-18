import { inNativeApp } from "@/lib/ble";

type AlertOptions = {
  id: number;
  title: string;
  body: string;
  until?: number;
};

type PhonePlugin = {
  alert: (options: AlertOptions) => Promise<void>;
  clearAlert: (options: { id: number }) => Promise<void>;
};

async function phone() {
  if (!(await inNativeApp())) return null;
  const { registerPlugin } = await import("@capacitor/core");
  return registerPlugin<PhonePlugin>("ProxyProofBle");
}

export async function phoneAlert(options: AlertOptions) {
  const native = await phone();
  if (native) {
    await native.alert(options);
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(options.title, { body: options.body });
  }
}

export async function clearPhoneAlert(id: number) {
  const native = await phone();
  if (native) await native.clearAlert({ id });
}
