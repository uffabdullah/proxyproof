"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deviceLabel, getDeviceSecret } from "@/lib/device";
import { bleScanSupported, listenForRssi } from "@/lib/geo";
import { RSSI_IN_ROOM, listenForBeacons, type HeardBeacon } from "@/lib/ble";
import { playForReason, unlockSound } from "@/lib/sound";
import { PROFILE_COLUMNS, type MarkResult, type Profile } from "@/lib/types";

type BleState = {
  supported: boolean;
  on: boolean;
  rssi: number | null;
  error: string | null;
};

type RoomContextValue = {
  ready: boolean;
  email: string | null;
  profile: Profile | null;
  deviceStatus: "active" | "pending" | "revoked" | "none" | null;
  deviceError: string | null;
  locState: "unknown" | "on" | "off";
  ble: BleState;
  statuses: Record<string, MarkResult>;
  refreshDevice: () => Promise<void>;
  listenBle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoom() {
  const value = useContext(RoomContext);
  if (!value) throw new Error("useRoom must be used inside the room");
  return value;
}

export function RoomProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<RoomContextValue["deviceStatus"]>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [locState, setLocState] = useState<RoomContextValue["locState"]>("unknown");
  const [ble, setBle] = useState<BleState>({
    supported: false,
    on: false,
    rssi: null,
    error: null,
  });
  const [statuses, setStatuses] = useState<Record<string, MarkResult>>({});
  const rssiRef = useRef<number | null>(null);
  const heardReason = useRef<Record<string, string>>({});
  const beacons = useRef<Record<string, HeardBeacon>>({});
  const tracked = useRef<Record<string, string>>({});
  const stopBle = useRef<null | (() => void)>(null);

  async function bindDevice() {
    setDeviceError(null);
    const { data, error } = await supabase.rpc("register_device", {
      p_secret: getDeviceSecret(),
      p_label: deviceLabel(),
    });
    if (error) {
      setDeviceError(error.message);
      setDeviceStatus("none");
      return;
    }
    const status = (data as { status?: RoomContextValue["deviceStatus"] } | null)?.status ?? "none";
    setDeviceStatus(status);
  }

  useEffect(() => {
    let ignore = false;
    setBle((current) => ({ ...current, supported: bleScanSupported() }));

    async function load() {
      const { data: userData } = await supabase.auth.getUser();
      const user = userData.user;
      if (!user) {
        router.replace("/login");
        return;
      }
      if (ignore) return;
      setEmail(user.email ?? null);

      let nextProfile: Profile | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data } = await supabase
          .from("profiles")
          .select(PROFILE_COLUMNS)
          .eq("id", user.id)
          .maybeSingle();
        if (data) {
          nextProfile = data as Profile;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (ignore) return;
      setProfile(nextProfile);
      setReady(true);
      if (nextProfile?.role === "student") await bindDevice();
    }

    load();
    return () => {
      ignore = true;
    };
    // bindDevice closes over the latest client, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, supabase]);

  useEffect(() => {
    if (!profile || profile.role !== "student" || deviceStatus !== "active") return;
    const stop = { current: false };
    const timer = { current: 0 as number | null };

    const armSound = () => unlockSound();
    window.addEventListener("pointerdown", armSound, { once: true });

    let stopListen = () => {};
    listenForBeacons((beacon) => {
      beacons.current[beacon.sessionPrefix] = beacon;
      rssiRef.current = beacon.rssi;
      setBle((current) => ({ ...current, on: true, supported: true, rssi: beacon.rssi, error: null }));
    })
      .then((stopScan) => {
        stopListen = stopScan;
        setBle((current) => ({ ...current, on: true, supported: true }));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Bluetooth did not start.";
        setBle((current) => ({ ...current, on: false, supported: false, error: message }));
      });

    const tick = async () => {
      if (stop.current) return;
      const fresh = Object.values(beacons.current).filter((beacon) => Date.now() - beacon.at < 8000);
      const seen = new Set<string>();
      const next: Record<string, MarkResult> = {};

      for (const beacon of fresh) {
        const strong = beacon.rssi >= RSSI_IN_ROOM && beacon.rssi <= 0;
        const args = {
          p_secret: getDeviceSecret(),
          p_session_id: null,
          p_token: beacon.token,
          p_student_id: profile.id,
          p_rssi: beacon.rssi,
          p_session_prefix: beacon.sessionPrefix,
        };
        const marked = strong
          ? await supabase.rpc("auto_mark", args)
          : await supabase.rpc("presence_ping", args);
        let result = (marked.data ?? { ok: false, reason: "error" }) as MarkResult;
        let error = marked.error;
        if (!error && strong && (result.reason === "marked" || result.reason === "already" || result.reason === "present")) {
          const ping = await supabase.rpc("presence_ping", args);
          if (!ping.error && ping.data) result = ping.data as MarkResult;
          else if (ping.error) error = ping.error;
        }
        const key = result.session_id || beacon.sessionPrefix;
        if (result.session_id) {
          tracked.current[result.session_id] = beacon.sessionPrefix;
          seen.add(result.session_id);
        }
        seen.add(beacon.sessionPrefix);
        if (error) {
          next[key] = { ok: false, reason: "error", message: error.message, title: "Beacon", course: "Bluetooth" };
        } else {
          if (result.reason === "grace") {
            result = { ...result, message: `${result.seconds ?? 30}s to get back in Bluetooth range before this becomes an absence.` };
          }
          if (result.reason === "present" || result.reason === "marked") {
            result = { ...result, message: `In the room${beacon.rssi ? ` · ${beacon.rssi} dBm` : ""}. Stay until the session ends.` };
          }
          if (result.reason && result.reason !== heardReason.current[key]) {
            playForReason(result.reason);
            heardReason.current[key] = result.reason;
          }
          next[key] = result;
        }
      }

      for (const [sessionId, prefix] of Object.entries(tracked.current)) {
        if (seen.has(sessionId) || seen.has(prefix)) continue;
        const ping = await supabase.rpc("presence_ping", {
          p_secret: getDeviceSecret(),
          p_session_id: sessionId,
          p_token: null,
          p_student_id: profile.id,
          p_rssi: null,
          p_session_prefix: null,
        });
        const result = (ping.data ?? { ok: false, reason: "error" }) as MarkResult;
        if (result.reason === "grace") {
          result.message = `${result.seconds ?? 30}s to get back in Bluetooth range before this becomes an absence.`;
        }
        if (result.reason === "absent" || result.reason === "closed") delete tracked.current[sessionId];
        if (result.reason && result.reason !== heardReason.current[sessionId]) {
          playForReason(result.reason);
          heardReason.current[sessionId] = result.reason;
        }
        next[sessionId] = result;
      }

      if (!stop.current) setStatuses(next);
      if (!stop.current) timer.current = window.setTimeout(tick, 2000);
    };

    timer.current = window.setTimeout(tick, 600);

    return () => {
      stop.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      stopListen();
      window.removeEventListener("pointerdown", armSound);
    };
  }, [deviceStatus, profile, supabase]);

  async function listenBle() {
    setBle((current) => ({ ...current, error: null }));
    try {
      stopBle.current?.();
      stopBle.current = await listenForRssi((rssi) => {
        rssiRef.current = rssi;
        setBle((current) => ({ ...current, on: true, rssi, error: null }));
      });
      setBle((current) => ({ ...current, on: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bluetooth could not start.";
      setBle((current) => ({ ...current, on: false, error: message }));
    }
  }

  async function signOut() {
    stopBle.current?.();
    await supabase.auth.signOut();
    router.replace("/");
    router.refresh();
  }

  const value: RoomContextValue = {
    ready,
    email,
    profile,
    deviceStatus,
    deviceError,
    locState,
    ble,
    statuses,
    refreshDevice: bindDevice,
    listenBle,
    signOut,
  };

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}
