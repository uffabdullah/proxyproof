"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ago, downloadCsv, formatRemaining, statusCopy } from "@/lib/format";
import { advertiseBeacon, inNativeApp, stopBeacon } from "@/lib/ble";
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

export default function LiveSession() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { ready, profile, statuses } = useRoom();
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
    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, supabase]);

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
        } catch (error) {
          const message = error instanceof Error ? error.message : "Bluetooth advertising did not start.";
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

  const mine = profile.id === session.organiser_id && profile.role === "organiser";
  const people = new Map(students.map((student) => [student.id, student]));
  const remaining = new Date(session.ends_at).getTime() - now;
  const live = session.status === "live" && remaining > 0;
  const presentIds = new Set(marks.map((mark) => mark.student_id));
  const waiting = students.filter((student) => !presentIds.has(student.id));

  async function addStudent() {
    if (!picked) return;
    const { error: rpcError } = await supabase.rpc("manual_mark", {
      p_session_id: session!.id,
      p_student_id: picked,
    });
    if (rpcError) setError(rpcError.message);
    else {
      setPicked("");
      load();
    }
  }

  async function remove(studentId: string) {
    const { error: rpcError } = await supabase.rpc("remove_mark", {
      p_session_id: session!.id,
      p_student_id: studentId,
    });
    if (rpcError) setError(rpcError.message);
    else load();
  }

  async function close() {
    const { error: rpcError } = await supabase.rpc("close_session", { p_session_id: session!.id });
    if (rpcError) setError(rpcError.message);
    else {
      setConfirmClose(false);
      load();
    }
  }

  function exportMarks() {
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
    downloadCsv(`${session!.course}-${session!.title}.csv`.replace(/\s+/g, "-").toLowerCase(), rows);
  }

  if (!mine) {
    const mineStatus = statuses[session.id];
    return (
      <Shell kicker={session.course}>
        <h1 className="serif mt-3 text-5xl">{session.title}</h1>
        <p className="mt-4 max-w-lg text-lg text-ink/70">
          {mineStatus ? statusCopy(mineStatus.reason, mineStatus.distance) : live ? "Listening for this beacon from your room page." : "This session is closed."}
        </p>
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
            {live ? `Broadcasting · ${formatRemaining(remaining)} left` : "Closed"}
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
        {live && !confirmClose && (
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

      <section className="mt-8 divide-y divide-ink/10 border-y border-ink/10">
        {marks.length === 0 && <p className="py-6 text-ink/60">Nobody is marked yet.</p>}
        {marks.map((mark) => {
          const student = people.get(mark.student_id);
          return (
            <div key={mark.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="font-medium">{student?.full_name || "Student"}</p>
                <p className="text-sm text-ink/50">
                  {student?.student_code} · {mark.presence === "absent" ? "absent" : mark.presence === "grace" ? `leaving · ${Math.max(0, Math.ceil((new Date(mark.grace_until || 0).getTime() - now) / 1000))}s` : mark.method} · {ago(mark.marked_at)}
                  {mark.distance_meters != null ? ` · ${Math.round(Number(mark.distance_meters))}m` : ""}
                  {mark.rssi != null ? ` · ${mark.rssi} dBm` : ""}
                </p>
              </div>
              {live && (
                <button type="button" className="text-sm underline" onClick={() => remove(mark.student_id)}>
                  Remove
                </button>
              )}
            </div>
          );
        })}
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
