"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ago, downloadCsv, formatRemaining, statusCopy } from "@/lib/format";
import { advertiseBeacon, inNativeApp, stopBeacon } from "@/lib/ble";
import { logDebug } from "@/lib/debug";
import { getDeviceSecret } from "@/lib/device";
import { phoneAlert } from "@/lib/phone";
import {
  ATTENDANCE_COLUMNS,
  PROFILE_COLUMNS,
  SESSION_COLUMNS,
  type AttendanceRow,
  type Profile,
  type SessionRow,
} from "@/lib/types";
import { useRoom } from "./RoomProvider";
import Shell from "./Shell";

const joinedNotified = new Set<string>();

export default function LiveSession() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { ready, profile, statuses, ble, deviceStatus } = useRoom();
  const supabase = useMemo(() => createClient(), []);
  const [session, setSession] = useState<SessionRow | null>(null);
  const [marks, setMarks] = useState<AttendanceRow[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [picked, setPicked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmClose, setConfirmClose] = useState(false);
  const [epoch, setEpoch] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [cohost, setCohost] = useState(false);
  const [joinNote, setJoinNote] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("sessions").select(SESSION_COLUMNS).eq("id", id).maybeSingle();
    if (!data) {
      setMissing(true);
      return;
    }
    setSession(data as SessionRow);
    const [{ data: markRows }, { data: studentRows }] = await Promise.all([
      supabase.from("attendance").select(ATTENDANCE_COLUMNS).eq("session_id", id).order("marked_at"),
      supabase.from("profiles").select(PROFILE_COLUMNS).eq("role", "student").order("full_name"),
    ]);
    setMarks((markRows as AttendanceRow[] | null) ?? []);
    setStudents((studentRows as Profile[] | null) ?? []);
  }

  useEffect(() => {
    load();
    const channel = supabase
      .channel(`session-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance", filter: `session_id=eq.${id}` }, () => load())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${id}` }, () => load())
      .subscribe();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(load, 2000);
    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, supabase]);

  useEffect(() => {
    if (!profile) return;
    let ignore = false;
    supabase
      .from("session_hosts")
      .select("profile_id")
      .eq("session_id", id)
      .eq("profile_id", profile.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!ignore) setCohost(Boolean(data));
      });
    return () => {
      ignore = true;
    };
  }, [id, profile, supabase]);

  useEffect(() => {
    if (!profile || profile.role !== "student" || !session || session.status !== "live") return;
    let ignore = false;
    const supabaseClient = supabase;
    supabaseClient
      .rpc("join_class", { p_session_id: session.id, p_secret: getDeviceSecret() })
      .then(({ data, error: rpcError }) => {
        if (ignore) return;
        const result = (data ?? {}) as { ok?: boolean; reason?: string; title?: string };
        logDebug("join", rpcError ? rpcError.message : result.reason || "no response", result);
        if (rpcError) {
          setJoinNote(rpcError.message);
          return;
        }
        if (result.reason === "pending") {
          setJoinNote("This phone is waiting for an organiser to approve it.");
          return;
        }
        if (result.reason === "joined" || result.reason === "present" || result.reason === "already") {
          setJoinNote(result.reason === "present" ? "You're marked present." : "You joined this class. The organiser can see you.");
          if (result.reason === "joined" && !joinedNotified.has(session.id)) {
            joinedNotified.add(session.id);
            void phoneAlert({
              id: 4106,
              title: "You joined the class",
              body: `${result.title || session.title} can see you on the roster.`,
            });
          }
        } else if (result.reason) {
          setJoinNote(statusCopy(result.reason));
        }
        load();
      });
    return () => {
      ignore = true;
    };
    // load refreshes the roster after the join is recorded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, profile?.role, session?.id, session?.status, supabase]);

  useEffect(() => {
    if (!session || session.status !== "live" || profile?.id !== session.organiser_id) return;
    let stop = false;
    const channel = supabase.channel("proxyproof-beacons");

    const pulse = async () => {
      if (stop) return;
      const { data, error: rpcError } = await supabase.rpc("beacon_pulse", { p_session_id: session.id });
      if (rpcError) {
        setError(rpcError.message);
        return;
      }
      const body = data as { ok?: boolean; reason?: string; epoch?: number; token?: string } | null;
      if (!body?.ok) {
        if (body?.reason === "closed") load();
        return;
      }
      setEpoch(body.epoch ?? null);
      setError(null);
      if (!body.token) return;
      if (await inNativeApp()) {
          try {
            await advertiseBeacon(session.id, body.token);
            logDebug("bluetooth", "Beacon is broadcasting");
          } catch (error) {
            const message = error instanceof Error ? error.message : "Bluetooth advertising did not start.";
            logDebug("bluetooth", message);
            setError(message);
          }
        return;
      }
      await channel.send({
        type: "broadcast",
        event: "token",
        payload: { token: body.token, sessionId: session.id, epoch: body.epoch },
      });
    };

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") pulse();
    });
    const timer = window.setInterval(pulse, 3000);
    return () => {
      stop = true;
      window.clearInterval(timer);
      supabase.removeChannel(channel);
      void stopBeacon();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, session?.id, session?.status, supabase]);

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center">
        <p className="serif text-4xl">Opening the room…</p>
      </div>
    );
  }
  if (missing || !session || !profile) {
    return (
      <Shell>
        <h1 className="serif mt-6 text-5xl">That session is gone.</h1>
        <Link href="/room" className="btn btn-ink mt-6">Back</Link>
      </Shell>
    );
  }

  const owner = profile.id === session.organiser_id;
  const canManage = profile.role === "organiser" && (owner || cohost);
  const people = new Map(students.map((student) => [student.id, student]));
  const remaining = new Date(session.ends_at).getTime() - now;
  const live = session.status === "live" && remaining > 0;
  const presentIds = new Set(marks.map((mark) => mark.student_id));
  const waiting = students.filter((student) => !presentIds.has(student.id));

  async function markPresent(studentId: string) {
    const { error: rpcError } = await supabase.rpc("manual_mark", {
      p_session_id: session!.id,
      p_student_id: studentId,
    });
    if (rpcError) setError(rpcError.message);
    else {
      setPicked("");
      load();
    }
  }

  async function addStudent() {
    if (!picked) return;
    await markPresent(picked);
  }

  async function remove(studentId: string) {
    const { error: rpcError } = await supabase.rpc("remove_mark", {
      p_session_id: session!.id,
      p_student_id: studentId,
    });
    if (rpcError) setError(rpcError.message);
    else load();
  }

  async function markAbsent(studentId: string) {
    const { error: rpcError } = await supabase.rpc("mark_absent", {
      p_session_id: session!.id,
      p_student_id: studentId,
    });
    if (rpcError) setError(rpcError.message);
    else load();
  }

  async function becomeHost() {
    const { error: rpcError } = await supabase.rpc("join_as_host", { p_session_id: session!.id });
    if (rpcError) setError(rpcError.message);
    else setCohost(true);
  }

  async function close() {
    const { error: rpcError } = await supabase.rpc("close_session", { p_session_id: session!.id });
    if (rpcError) setError(rpcError.message);
    else {
      setConfirmClose(false);
      load();
    }
  }

  async function exportMarks() {
    const rows = [["name", "code", "marked_at", "method", "presence", "rssi", "distance_m"]];
    marks.forEach((mark) => {
      const student = people.get(mark.student_id);
      rows.push([
        student?.full_name || "",
        student?.student_code || "",
        new Date(mark.marked_at).toISOString(),
        mark.method,
        mark.presence,
        mark.rssi == null ? "" : String(mark.rssi),
        mark.distance_meters == null ? "" : String(mark.distance_meters),
      ]);
    });
    try {
      await downloadCsv(`${session!.course}-${session!.title}.csv`.replace(/\s+/g, "-").toLowerCase(), rows);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The CSV could not be exported.");
    }
  }

  if (profile.role === "organiser" && !canManage) {
    return (
      <Shell kicker={session.course}>
        <h1 className="serif mt-3 text-5xl">{session.title}</h1>
        <p className="mt-4 max-w-lg text-lg text-ink/70">
          Another organiser is running this class. Join it to become a co-host. You can then add students, remove them, and mark them present or absent.
        </p>
        {error && <p className="mt-4 rounded-2xl bg-coral/10 px-4 py-3 text-sm">{error}</p>}
        <button type="button" className="btn btn-ink mt-8" onClick={becomeHost}>Join as co-host</button>
      </Shell>
    );
  }

  if (!canManage) {
    const mineStatus = statuses[session.id];
    const mineRow = marks.find((mark) => mark.student_id === profile.id);
    const confirmed = mineRow?.presence === "present" || (mineStatus && ["marked", "present", "already"].includes(mineStatus.reason));
    const warning = mineRow?.presence === "grace" || mineStatus?.reason === "grace" || mineStatus?.reason === "weak" || mineStatus?.reason === "far";
    return (
      <Shell kicker={session.course}>
        <h1 className="serif mt-3 text-5xl">{session.title}</h1>
        {deviceStatus === "pending" && (
          <p className="mt-4 max-w-lg rounded-2xl bg-coral/10 px-4 py-3 text-sm">
            This phone is waiting for an organiser to approve it. Attendance cannot be marked until then.
          </p>
        )}
        {(confirmed || mineRow?.presence === "joined" || joinNote) && !warning && (
          <div className="mt-6 max-w-lg rounded-3xl bg-ink px-5 py-6 text-foam">
            <p className="eyebrow text-foam/60">{confirmed ? "Present" : "Joined"}</p>
            <p className="serif mt-2 text-4xl">{confirmed ? "You're marked present." : "You joined this class."}</p>
            <p className="mt-2 text-foam/70">
              {confirmed
                ? `${session.course} has you on the roster. Stay until the class ends.`
                : joinNote || "The organiser can see your name. Stay inside the room to be marked present."}
            </p>
          </div>
        )}
        {warning && (
          <div className="mt-6 max-w-lg rounded-3xl bg-coral px-5 py-6 text-foam">
            <p className="eyebrow text-foam/80">Outside the room</p>
            <Countdown seconds={mineStatus?.seconds ?? 30} />
            <p className="mt-2">Get back in range before this mark becomes an absence. The same countdown is on your notification.</p>
          </div>
        )}
        {!confirmed && !warning && !joinNote && mineRow?.presence !== "joined" && (
          <p className="mt-4 max-w-lg text-lg text-ink/70">
            {live
              ? mineStatus
                ? statusCopy(mineStatus.reason, mineStatus.distance)
                : "Joined. Stay nearby with this screen open. You'll get a confirmation as soon as the room marks you present."
              : "This session is closed."}
          </p>
        )}
        {ble.rssi != null && (
          <p className="mt-4 text-sm text-ink/60">Bluetooth signal {ble.rssi} dBm{ble.rssi >= -68 ? " · inside the room" : " · outside the room"}</p>
        )}
        <Link href="/room" className="btn btn-ink mt-8">Back to your room</Link>
      </Shell>
    );
  }

  return (
    <Shell kicker={session.course}>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="serif text-5xl md:text-6xl">{session.title}</h1>
          <p className="mt-3 text-ink/70">
            {live ? `${owner ? "Broadcasting" : "Co-host"} · ${formatRemaining(remaining)} left` : "Closed"}
            {session.radius_meters ? ` · ${session.radius_meters}m room` : ""}
          </p>
        </div>
        <div className="orb" aria-hidden style={{ animationDuration: epoch ? "5s" : undefined }} />
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-ink px-4 py-2 text-sm text-foam">
          {marks.filter((mark) => mark.presence === "present").length} present
          {marks.some((mark) => mark.presence === "grace")
            ? ` · ${marks.filter((mark) => mark.presence === "grace").length} leaving`
            : ""}
        </span>
        <button type="button" className="btn btn-ghost" onClick={exportMarks}>Export CSV</button>
        {live && owner && !confirmClose && (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmClose(true)}>Close session</button>
        )}
        {confirmClose && (
          <>
            <button type="button" className="btn btn-coral" onClick={close}>Close it now</button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmClose(false)}>Keep it open</button>
          </>
        )}
      </div>
      {error && <p className="mt-4 rounded-2xl bg-coral/10 px-4 py-3 text-sm">{error}</p>}
      {live && (
        <p className="mt-4 max-w-xl text-sm text-ink/60">
          Leave this screen open. A student who walks out has 30 seconds to return. After that they are marked absent.
        </p>
      )}

      <section className="mt-8">
        <h2 className="serif text-3xl">Joined</h2>
        <div className="mt-3 divide-y divide-ink/10 border-y border-ink/10">
          {marks.filter((mark) => mark.presence === "joined").length === 0 && (
            <p className="py-6 text-ink/60">No one has joined yet.</p>
          )}
          {marks.filter((mark) => mark.presence === "joined").map((mark) => {
            const student = people.get(mark.student_id);
            return (
              <div key={mark.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">{student?.full_name || "Student"}</p>
                  <p className="text-sm text-ink/50">{student?.student_code} · joined, waiting for the room signal</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="serif text-3xl">In the room</h2>
        <div className="mt-3 divide-y divide-ink/10 border-y border-ink/10">
          {marks.filter((mark) => mark.presence === "present").length === 0 && (
            <p className="py-6 text-ink/60">Nobody in range yet. Names appear here as soon as a student is marked.</p>
          )}
          {marks.filter((mark) => mark.presence === "present").map((mark) => {
            const student = people.get(mark.student_id);
            return (
              <div key={mark.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">{student?.full_name || "Student"}</p>
                  <p className="text-sm text-ink/50">
                    {student?.student_code} · present · {ago(mark.marked_at)}
                    {mark.rssi != null ? ` · ${mark.rssi} dBm` : ""}
                    {mark.distance_meters != null ? ` · ${Math.round(Number(mark.distance_meters))}m` : ""}
                  </p>
                </div>
                {live && (
                  <div className="flex gap-3 text-sm">
                    <button type="button" className="underline" onClick={() => markAbsent(mark.student_id)}>Mark absent</button>
                    <button type="button" className="underline" onClick={() => remove(mark.student_id)}>Remove</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="serif text-3xl">Leaving or absent</h2>
        <div className="mt-3 divide-y divide-ink/10 border-y border-ink/10">
          {marks.filter((mark) => mark.presence !== "present").length === 0 && (
            <p className="py-6 text-ink/60">No one is outside the room.</p>
          )}
          {marks.filter((mark) => mark.presence !== "present").map((mark) => {
            const student = people.get(mark.student_id);
            const left = mark.grace_until ? Math.max(0, Math.ceil((new Date(mark.grace_until).getTime() - now) / 1000)) : 0;
            return (
              <div key={mark.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">{student?.full_name || "Student"}</p>
                  <p className="text-sm text-ink/50">
                    {student?.student_code} · {mark.presence === "grace" ? `outside · ${left}s` : "absent"}
                  </p>
                </div>
                {live && (
                  <div className="flex gap-3 text-sm">
                    <button type="button" className="underline" onClick={() => markPresent(mark.student_id)}>Mark present</button>
                    {mark.presence !== "absent" && (
                      <button type="button" className="underline" onClick={() => markAbsent(mark.student_id)}>Mark absent</button>
                    )}
                    <button type="button" className="underline" onClick={() => remove(mark.student_id)}>Remove</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {live && (
        <div className="mt-6 flex flex-wrap gap-3">
          <select className="field max-w-sm" value={picked} onChange={(event) => setPicked(event.target.value)}>
            <option value="">Add a student by hand</option>
            {waiting.map((student) => (
              <option key={student.id} value={student.id}>
                {student.full_name} · {student.student_code}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ink" onClick={addStudent} disabled={!picked}>
            Add
          </button>
        </div>
      )}
    </Shell>
  );
}

function Countdown({ seconds }: { seconds: number }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const timer = window.setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [seconds]);
  return <p className="serif mt-2 text-7xl leading-none">{left}s</p>;
}
