"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { currentFix } from "@/lib/geo";
import { ago, downloadCsv, formatWhen, statusCopy } from "@/lib/format";
import {
  ATTENDANCE_COLUMNS,
  DEVICE_COLUMNS,
  PROFILE_COLUMNS,
  SESSION_COLUMNS,
  type AttendanceRow,
  type DeviceRow,
  type Profile,
  type SessionRow,
} from "@/lib/types";
import { useRoom } from "./RoomProvider";
import Shell from "./Shell";

export default function RoomHome() {
  const room = useRoom();
  if (!room.ready) {
    return (
      <div className="grid min-h-screen place-items-center">
        <p className="serif text-4xl">Opening the room…</p>
      </div>
    );
  }
  if (!room.profile) {
    return (
      <div className="grid min-h-screen place-items-center px-6 text-center">
        <p className="max-w-md text-lg">Your profile has not appeared yet. Refresh in a moment.</p>
      </div>
    );
  }
  return room.profile.role === "organiser" ? <OrganiserHome /> : <StudentHome />;
}

function StudentHome() {
  const { profile, deviceStatus, deviceError, locState, ble, statuses, refreshDevice, listenBle, inApp } = useRoom();
  const [history, setHistory] = useState<Array<SessionRow & { marked_at?: string; method?: string; presence?: string }>>([]);
  const [closedCount, setClosedCount] = useState(0);
  const [attendedCount, setAttendedCount] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let ignore = false;
    async function load() {
      if (!profile) return;
      await supabase.rpc("sweep_sessions");
      const [{ data: sessions }, { data: marks }] = await Promise.all([
        supabase.from("sessions").select(SESSION_COLUMNS).order("started_at", { ascending: false }),
        supabase.from("attendance").select(ATTENDANCE_COLUMNS).eq("student_id", profile.id),
      ]);
      if (ignore) return;
      const markMap = new Map((marks as AttendanceRow[] | null)?.map((mark) => [mark.session_id, mark]));
      const rows = ((sessions as SessionRow[] | null) ?? []).filter(
        (session) => session.started_at >= profile.created_at,
      );
      const closed = rows.filter((session) => session.status === "closed");
      setClosedCount(closed.length);
      setAttendedCount(closed.filter((session) => markMap.get(session.id)?.presence === "present").length);
      setHistory(
        rows
          .filter((session) => markMap.has(session.id) || session.status === "closed")
          .slice(0, 12)
          .map((session) => ({
            ...session,
            marked_at: markMap.get(session.id)?.marked_at,
            method: markMap.get(session.id)?.method,
            presence: markMap.get(session.id)?.presence,
          })),
      );
    }
    load();
    return () => {
      ignore = true;
    };
  }, [profile, statuses]);

  const percent = closedCount === 0 ? null : Math.round((attendedCount / closedCount) * 100);
  const live = Object.entries(statuses);

  return (
    <Shell kicker={profile?.student_code || "Student"}>
      <h1 className="serif mt-3 text-5xl md:text-6xl">Hello, {profile?.full_name.split(" ")[0]}.</h1>
      <p className="mt-3 max-w-xl text-ink/70">
        Keep this page open during class. If the beacon is live and you are in the room, you are marked without typing anything.
      </p>

      {deviceStatus === "pending" && (
        <div className="panel mt-6 p-5">
          <p className="font-medium">This phone is waiting for approval.</p>
          <p className="mt-1 text-sm text-ink/70">Your previous phone still marks you. An organiser has to switch the binding.</p>
          <button type="button" className="btn btn-ghost mt-4" onClick={() => refreshDevice()}>
            Check again
          </button>
        </div>
      )}
      {deviceStatus === "revoked" && (
        <div className="panel mt-6 p-5">
          <p className="font-medium">An organiser declined this phone.</p>
          <button type="button" className="btn btn-ink mt-4" onClick={() => refreshDevice()}>
            Request it again
          </button>
        </div>
      )}
      {deviceError && <p className="mt-4 rounded-2xl bg-coral/10 px-4 py-3 text-sm">{deviceError}</p>}

      <div className="mt-8 grid gap-4 md:grid-cols-[180px_1fr]">
        <div className="panel grid place-items-center p-6 text-center">
          <p className="eyebrow text-ink/50">Attendance</p>
          <p className="serif mt-2 text-6xl">{percent == null ? "—" : `${percent}%`}</p>
          <p className="mt-2 text-sm text-ink/60">
            {closedCount === 0 ? "No closed sessions yet" : `${attendedCount} of ${closedCount}`}
          </p>
        </div>
        <div className="panel p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow text-ink/50">Listening</p>
              <p className="mt-2 text-lg">
                {inApp
                  ? ble.on
                    ? `Hearing the beacon${ble.rssi != null ? ` · ${ble.rssi} dBm` : ""}`
                    : "Starting Bluetooth"
                  : locState === "off"
                    ? "Location is off"
                    : locState === "on"
                      ? "Location stays on for the whole session"
                      : "Asking for location"}
              </p>
              <p className="mt-1 text-sm text-ink/60">
                {inApp
                  ? "You are marked only while this phone hears a strong Bluetooth beacon. Step out and you have 30 seconds to return."
                  : "Leave the room and you have 30 seconds to return. After that, the mark becomes an absence."}
              </p>
            </div>
            {ble.supported && (
              <button type="button" className="btn btn-ghost" onClick={() => listenBle()}>
                {ble.on ? "Bluetooth listening" : "Listen with Bluetooth"}
              </button>
            )}
          </div>
          {ble.error && <p className="mt-3 text-sm text-ink/70">{ble.error}</p>}
          <div className="mt-5 space-y-3">
            {live.length === 0 && <p className="text-ink/60">No live session right now.</p>}
            {live.map(([id, status]) => (
              <div key={id} className="rounded-2xl bg-sand/70 px-4 py-3">
                <p className="font-medium">{status.course} · {status.title}</p>
                <p className="text-sm text-ink/70">{status.message || statusCopy(status.reason, status.distance)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="serif text-3xl">History</h2>
        <div className="mt-4 divide-y divide-ink/10 border-y border-ink/10">
          {history.length === 0 && <p className="py-6 text-ink/60">Sessions you attend will collect here.</p>}
          {history.map((session) => (
            <div key={session.id} className="flex items-center justify-between gap-4 py-4">
              <div>
                <p className="font-medium">{session.title}</p>
                <p className="text-sm text-ink/50">{session.course} · {formatWhen(session.started_at)}</p>
              </div>
              <p className="text-sm">
                {!session.marked_at || session.presence === "absent"
                  ? "Absent"
                  : session.presence === "grace"
                    ? "Leaving"
                    : `Present · ${session.method}`}
              </p>
            </div>
          ))}
        </div>
      </section>
    </Shell>
  );
}

function OrganiserHome() {
  const { profile } = useRoom();
  const supabase = useMemo(() => createClient(), []);
  const [title, setTitle] = useState("");
  const [course, setCourse] = useState("");
  const [minutes, setMinutes] = useState(5);
  const [radius, setRadius] = useState(50);
  const [allowManualOnly, setAllowManualOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [marks, setMarks] = useState<AttendanceRow[]>([]);
  const [devices, setDevices] = useState<Array<DeviceRow & { full_name?: string; student_code?: string | null }>>([]);

  async function load() {
    await supabase.rpc("sweep_sessions");
    const [{ data: sessionRows }, { data: studentRows }, { data: markRows }, { data: deviceRows }] = await Promise.all([
      supabase.from("sessions").select(SESSION_COLUMNS).order("started_at", { ascending: false }),
      supabase.from("profiles").select(PROFILE_COLUMNS).eq("role", "student").order("full_name"),
      supabase.from("attendance").select(ATTENDANCE_COLUMNS),
      supabase.from("devices").select(DEVICE_COLUMNS).eq("status", "pending").order("created_at"),
    ]);
    const people = new Map(((studentRows as Profile[] | null) ?? []).map((student) => [student.id, student]));
    setSessions((sessionRows as SessionRow[] | null) ?? []);
    setStudents((studentRows as Profile[] | null) ?? []);
    setMarks((markRows as AttendanceRow[] | null) ?? []);
    setDevices(
      ((deviceRows as DeviceRow[] | null) ?? []).map((device) => ({
        ...device,
        full_name: people.get(device.user_id)?.full_name,
        student_code: people.get(device.user_id)?.student_code,
      })),
    );
  }

  useEffect(() => {
    load();
    const channel = supabase
      .channel("organiser-home")
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // load is recreated each render; the channel only needs the stable client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  async function start(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const fix = allowManualOnly ? null : await currentFix();
    if (!fix && !allowManualOnly) {
      setPending(false);
      setError("Location was blocked. Turn it on, or start with manual marks only.");
      return;
    }
    const { data, error: rpcError } = await supabase.rpc("start_session", {
      p_title: title,
      p_course: course,
      p_duration: minutes * 60,
      p_lat: fix?.lat ?? null,
      p_lng: fix?.lng ?? null,
      p_radius: radius,
    });
    setPending(false);
    if (rpcError || !data) {
      setError(rpcError?.message || "The session did not start.");
      return;
    }
    window.location.href = `/room/${data}`;
  }

  async function review(id: string, approve: boolean) {
    const { error: rpcError } = await supabase.rpc("review_device", {
      p_device_id: id,
      p_approve: approve,
    });
    if (rpcError) setError(rpcError.message);
    else load();
  }

  const closed = sessions.filter((session) => session.status === "closed");
  const record = useMemo(() => {
    return students.map((student) => {
      const eligible = closed.filter((session) => session.started_at >= student.created_at);
      const attended = marks.filter(
        (mark) =>
          mark.student_id === student.id &&
          mark.presence === "present" &&
          eligible.some((session) => session.id === mark.session_id),
      ).length;
      const percent = eligible.length === 0 ? null : Math.round((attended / eligible.length) * 100);
      return { student, attended, total: eligible.length, percent };
    });
  }, [closed, marks, students]);

  function exportRecord() {
    const rows = [["name", "code", "attended", "sessions", "percent"]];
    record.forEach(({ student, attended, total, percent }) => {
      rows.push([student.full_name, student.student_code || "", String(attended), String(total), percent == null ? "" : String(percent)]);
    });
    downloadCsv("proxyproof-class.csv", rows);
  }

  return (
    <Shell kicker="Organiser">
      <h1 className="serif mt-3 text-5xl md:text-6xl">Start a beacon.</h1>
      <form onSubmit={start} className="panel mt-8 grid gap-4 p-5 md:grid-cols-2">
        <label>
          <span className="eyebrow text-ink/50">Session</span>
          <input className="field mt-2" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={120} placeholder="Lecture 12" />
        </label>
        <label>
          <span className="eyebrow text-ink/50">Course</span>
          <input className="field mt-2" value={course} onChange={(event) => setCourse(event.target.value)} required maxLength={80} placeholder="CS204" />
        </label>
        <label>
          <span className="eyebrow text-ink/50">Duration</span>
          <select className="field mt-2" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
            <option value={5}>5 minutes</option>
            <option value={10}>10 minutes</option>
            <option value={15}>15 minutes</option>
          </select>
        </label>
        <label>
          <span className="eyebrow text-ink/50">Room radius</span>
          <select className="field mt-2" value={radius} onChange={(event) => setRadius(Number(event.target.value))}>
            <option value={30}>30 metres</option>
            <option value={50}>50 metres</option>
            <option value={80}>80 metres</option>
          </select>
        </label>
        <label className="flex items-center gap-3 text-sm md:col-span-2">
          <input type="checkbox" checked={allowManualOnly} onChange={(event) => setAllowManualOnly(event.target.checked)} />
          Start without location. Automatic marks will not work; you can still add names by hand.
        </label>
        {error && <p className="rounded-2xl bg-coral/10 px-4 py-3 text-sm md:col-span-2">{error}</p>}
        <button className="btn btn-ink md:col-span-2" disabled={pending}>
          {pending ? "Finding the room…" : "Broadcast"}
        </button>
      </form>

      {devices.length > 0 && (
        <section className="mt-10">
          <h2 className="serif text-3xl">Phones waiting</h2>
          <div className="mt-4 space-y-3">
            {devices.map((device) => (
              <div key={device.id} className="panel flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div>
                  <p className="font-medium">{device.full_name || "Student"}</p>
                  <p className="text-sm text-ink/50">{device.student_code} · {device.label} · {ago(device.created_at)}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-ink px-4 py-2 text-sm" onClick={() => review(device.id, true)}>Approve</button>
                  <button type="button" className="btn btn-ghost px-4 py-2 text-sm" onClick={() => review(device.id, false)}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="serif text-3xl">Sessions</h2>
        <div className="mt-4 divide-y divide-ink/10 border-y border-ink/10">
          {sessions.length === 0 && <p className="py-6 text-ink/60">Nothing on the board yet.</p>}
          {sessions.map((session) => {
            const count = marks.filter((mark) => mark.session_id === session.id).length;
            const mine = session.organiser_id === profile?.id;
            return (
              <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">{session.title}</p>
                  <p className="text-sm text-ink/50">
                    {session.course} · {formatWhen(session.started_at)} · {count} present
                  </p>
                </div>
                {mine ? (
                  <Link href={`/room/${session.id}`} className="btn btn-ghost px-4 py-2 text-sm">
                    {session.status === "live" ? "Open beacon" : "View"}
                  </Link>
                ) : (
                  <span className="text-sm capitalize text-ink/50">{session.status}</span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-end justify-between gap-4">
          <h2 className="serif text-3xl">Class record</h2>
          <button type="button" className="btn btn-ghost px-4 py-2 text-sm" onClick={exportRecord}>
            Export CSV
          </button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="eyebrow text-ink/50">
              <tr>
                <th className="py-3 font-medium">Student</th>
                <th className="py-3 font-medium">Code</th>
                <th className="py-3 font-medium">Present</th>
                <th className="py-3 font-medium">Percent</th>
              </tr>
            </thead>
            <tbody>
              {record.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-ink/60">Students appear here after they create an account.</td>
                </tr>
              )}
              {record.map(({ student, attended, total, percent }) => (
                <tr key={student.id} className="border-t border-ink/10">
                  <td className="py-3">{student.full_name}</td>
                  <td className="py-3 text-ink/60">{student.student_code}</td>
                  <td className="py-3">{attended}/{total}</td>
                  <td className="py-3">{percent == null ? "—" : `${percent}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}
