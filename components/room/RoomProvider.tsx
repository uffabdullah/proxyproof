"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deviceLabel, getDeviceSecret } from "@/lib/device";
import { bleScanSupported, listenForRssi, watchRoom, type Fix } from "@/lib/geo";
import { inNativeApp, listenForBeacons, RSSI_IN_ROOM } from "@/lib/ble";
import { clearPhoneAlert, phoneAlert } from "@/lib/phone";
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
  inApp: boolean;
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
  const [inApp, setInApp] = useState(false);
  const fixRef = useRef<Fix | null>(null);
  const rssiRef = useRef<number | null>(null);
  const tokens = useRef<Record<string, { token: string; at: number }>>({});
  const heardReason = useRef<Record<string, string>>({});
  const stopBle = useRef<null | (() => void)>(null);

  function remember(key: string, result: MarkResult) {
    const note =
      result.reason === "marked" || result.reason === "already" || result.reason === "present"
        ? "present"
        : result.reason;
    if (note && note !== heardReason.current[key]) {
      playForReason(result.reason);
      heardReason.current[key] = note;
      const label = result.title || result.course || "this class";
      if (note === "present") {
        void clearPhoneAlert(4103);
        void phoneAlert({ id: 4104, title: "You're marked present", body: `${label} confirmed your attendance.` });
      } else if (note === "grace") {
        const seconds = result.seconds ?? 30;
        void phoneAlert({
          id: 4103,
          title: "You're outside the room",
          body: `Get back in range. ${seconds} seconds left.`,
          until: Date.now() + seconds * 1000,
        });
      } else if (note === "absent") {
        void clearPhoneAlert(4103);
        void phoneAlert({ id: 4105, title: "Marked absent", body: `You stayed outside ${label}.` });
      }
    }
    return result;
  }

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
    let cancel = false;
    let dispose = () => {};
    inNativeApp().then((native) => {
      if (cancel) return;
      setInApp(native);
      dispose = native ? watchBluetooth() : watchRoomLocation();
    });
    return () => {
      cancel = true;
      dispose();
    };

    function watchRoomLocation() {
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
          next[session.id] = remember(session.id, { ...result, title: session.title, course: session.course });
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
    }

    function watchBluetooth() {
      const stop = { current: false };
      const timer = { current: 0 as number | null };
      const beacons: Record<string, { sessionPrefix: string; token: string; rssi: number; at: number }> = {};
      const tracked: Record<string, string> = {};
      let stopScan = () => {};
      const armSound = () => unlockSound();
      window.addEventListener("pointerdown", armSound, { once: true });
      listenForBeacons((beacon) => {
        beacons[beacon.sessionPrefix] = beacon;
        rssiRef.current = beacon.rssi;
        setBle((current) => ({ ...current, on: true, supported: true, rssi: beacon.rssi, error: null }));
      })
        .then((stopListening) => {
          stopScan = stopListening;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Bluetooth did not start.";
          setBle((current) => ({ ...current, on: false, error: message }));
        });

      const tick = async () => {
        if (stop.current) return;
        const fresh = Object.values(beacons).filter((beacon) => Date.now() - beacon.at < 8000);
        const seen = new Set<string>();
        const next: Record<string, MarkResult> = {};
        for (const beacon of fresh) {
          const strong = beacon.rssi >= RSSI_IN_ROOM && beacon.rssi <= 0;
          const args = {
            p_secret: getDeviceSecret(),
            p_session_id: null,
            p_token: beacon.token,
            p_student_id: profile!.id,
            p_rssi: beacon.rssi,
            p_session_prefix: beacon.sessionPrefix,
          };
          const marked = strong ? await supabase.rpc("auto_mark", args) : await supabase.rpc("presence_ping", args);
          let result = (marked.data ?? { ok: false, reason: "error" }) as MarkResult;
          let error = marked.error;
          if (!error && strong && (result.reason === "marked" || result.reason === "already" || result.reason === "present")) {
            const ping = await supabase.rpc("presence_ping", args);
            if (!ping.error && ping.data) result = ping.data as MarkResult;
            else if (ping.error) error = ping.error;
          }
          const key = result.session_id || beacon.sessionPrefix;
          if (result.session_id) {
            tracked[result.session_id] = beacon.sessionPrefix;
            seen.add(result.session_id);
          }
          if (error) {
            next[key] = { ok: false, reason: "error", message: error.message };
          } else {
            if (result.reason === "grace") {
              result = { ...result, message: `${result.seconds ?? 30}s to get back in Bluetooth range.` };
            }
            if (result.reason === "present" || result.reason === "marked") {
              result = { ...result, message: `In the room · ${beacon.rssi} dBm.` };
            }
            next[key] = remember(key, result);
          }
        }
        for (const [sessionId, prefix] of Object.entries(tracked)) {
          if (seen.has(sessionId) || fresh.some((beacon) => beacon.sessionPrefix === prefix)) continue;
          const ping = await supabase.rpc("presence_ping", {
            p_secret: getDeviceSecret(),
            p_session_id: sessionId,
            p_token: null,
            p_student_id: profile!.id,
            p_rssi: null,
            p_session_prefix: null,
          });
          const result = (ping.data ?? { ok: false, reason: "error" }) as MarkResult;
          if (result.reason === "grace") {
            result.message = `${result.seconds ?? 30}s to get back in Bluetooth range.`;
          }
          if (result.reason === "absent" || result.reason === "closed") delete tracked[sessionId];
          next[sessionId] = remember(sessionId, result);
        }
        if (!stop.current) setStatuses(next);
        if (!stop.current) timer.current = window.setTimeout(tick, 2000);
      };
      timer.current = window.setTimeout(tick, 600);
      return () => {
        stop.current = true;
        if (timer.current) window.clearTimeout(timer.current);
        stopScan();
        window.removeEventListener("pointerdown", armSound);
      };
    }
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
    inApp,
  };

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}
