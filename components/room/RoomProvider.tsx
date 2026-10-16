"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deviceLabel, getDeviceSecret } from "@/lib/device";
import { bleScanSupported, listenForRssi, watchRoom, type Fix } from "@/lib/geo";
import { playForReason, unlockSound } from "@/lib/sound";
import { PROFILE_COLUMNS, SESSION_COLUMNS, type MarkResult, type Profile } from "@/lib/types";

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
  const fixRef = useRef<Fix | null>(null);
  const rssiRef = useRef<number | null>(null);
  const tokens = useRef<Record<string, { token: string; at: number }>>({});
  const heardReason = useRef<Record<string, string>>({});
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

    const channel = supabase.channel("proxyproof-beacons");
    channel.on("broadcast", { event: "token" }, ({ payload }) => {
      const body = payload as { token?: string; sessionId?: string };
      if (!body.token || !body.sessionId) return;
      tokens.current[body.sessionId] = { token: body.token, at: Date.now() };
    });
    channel.subscribe();

    const armSound = () => unlockSound();
    window.addEventListener("pointerdown", armSound, { once: true });

    const stopWatch = watchRoom(
      (fix) => {
        fixRef.current = fix;
        setLocState("on");
      },
      () => setLocState("off"),
    );

    const tick = async () => {
      if (stop.current) return;
      const { data: sessions } = await supabase
        .from("sessions")
        .select(SESSION_COLUMNS)
        .eq("status", "live")
        .gt("ends_at", new Date().toISOString());

      const next: Record<string, MarkResult> = {};
      for (const session of (sessions ?? []) as Array<{ id: string; title: string; course: string }>) {
        const heard = tokens.current[session.id];
        const fresh = heard && Date.now() - heard.at < 8000 ? heard.token : null;
        const fix = fixRef.current;
        const args = {
          p_secret: getDeviceSecret(),
          p_session_id: session.id,
          p_lat: fix?.lat ?? null,
          p_lng: fix?.lng ?? null,
          p_rssi: rssiRef.current,
          p_accuracy: fix?.accuracy ?? null,
        };
        const marked = await supabase.rpc("auto_mark", { ...args, p_token: fresh });
        let result = (marked.data ?? { ok: false, reason: "error" }) as MarkResult;
        let error = marked.error;
        if (!error && (result.reason === "marked" || result.reason === "already" || result.reason === "present")) {
          const ping = await supabase.rpc("presence_ping", args);
          if (!ping.error && ping.data) result = ping.data as MarkResult;
          else if (ping.error) error = ping.error;
        }
        if (error) {
          next[session.id] = {
            ok: false,
            reason: "error",
            message: error.message,
            title: session.title,
            course: session.course,
          };
        } else {
          if (result.reason === "stale") delete tokens.current[session.id];
          if (result.reason === "grace") {
            result = {
              ...result,
              message: `${result.seconds ?? 30}s to get back in the room before this mark becomes an absence.`,
            };
          }
          if (result.reason && result.reason !== heardReason.current[session.id]) {
            playForReason(result.reason);
            heardReason.current[session.id] = result.reason;
          }
          next[session.id] = { ...result, title: session.title, course: session.course };
        }
      }
      if (!stop.current) setStatuses(next);
      const watching = Object.values(next).some((item) => item.reason === "grace" || item.reason === "present");
      if (!stop.current) timer.current = window.setTimeout(tick, watching ? 2000 : 4000);
    };

    timer.current = window.setTimeout(tick, 500);

    return () => {
      stop.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      stopWatch();
      window.removeEventListener("pointerdown", armSound);
      supabase.removeChannel(channel);
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
