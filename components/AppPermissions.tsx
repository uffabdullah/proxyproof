"use client";

import { useEffect, useState } from "react";
import { inNativeApp } from "@/lib/ble";
import { logDebug } from "@/lib/debug";

let prepareOnce: Promise<void> | null = null;

export default function AppPermissions() {
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    inNativeApp().then(async (native) => {
      if (!native || ignore) return;
      if (!prepareOnce) {
        prepareOnce = (async () => {
          const { registerPlugin } = await import("@capacitor/core");
          const phone = registerPlugin<{
            prepare: () => Promise<{ bluetooth?: boolean; notifications?: boolean }>;
          }>("ProxyProofBle");
          const result = await phone.prepare();
          logDebug("permissions", result.bluetooth ? "Bluetooth is allowed" : "Bluetooth is off", result);
        })();
      }
      try {
        await prepareOnce;
        if (!ignore) setNote("Bluetooth checked");
      } catch (error) {
        prepareOnce = null;
        const message = error instanceof Error ? error.message : "Bluetooth permission was not granted";
        logDebug("permissions", message);
        if (!ignore) setNote(message);
      }
    });
    return () => {
      ignore = true;
    };
  }, []);

  if (!note) return null;
  return (
    <p className="fixed top-3 left-1/2 z-40 max-w-[70vw] -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-center text-sm text-foam">
      {note}
    </p>
  );
}
