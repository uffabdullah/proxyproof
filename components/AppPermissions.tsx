"use client";

import { useEffect, useState } from "react";
import { inNativeApp } from "@/lib/ble";

export default function AppPermissions() {
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    inNativeApp().then(async (native) => {
      if (!native || ignore) return;
      try {
        const { registerPlugin } = await import("@capacitor/core");
        const phone = registerPlugin<{
          prepare: () => Promise<{ bluetooth?: boolean; notifications?: boolean }>;
        }>("ProxyProofBle");
        const result = await phone.prepare();
        if (ignore) return;
        setNote(result.bluetooth ? "Bluetooth is on" : "Turn Bluetooth on to mark attendance");
      } catch (error) {
        if (!ignore) setNote(error instanceof Error ? error.message : "Bluetooth permission was not granted");
      }
    });
    return () => {
      ignore = true;
    };
  }, []);

  if (!note) return null;
  return (
    <p className="fixed bottom-4 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-center text-sm text-foam">
      {note}
    </p>
  );
}
