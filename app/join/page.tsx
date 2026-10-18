"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PROFILE_COLUMNS, SESSION_COLUMNS, type Profile, type SessionRow } from "@/lib/types";
import Shell from "@/components/room/Shell";

export default function JoinPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [classes, setClasses] = useState<SessionRow[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    async function load() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;
      const { data } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", userData.user.id).maybeSingle();
      const next = data as Profile | null;
      setProfile(next);
      if (next?.role === "student") {
        await supabase.rpc("sweep_sessions");
        const { data: sessions } = await supabase.from("sessions").select(SESSION_COLUMNS).eq("status", "live").order("started_at", { ascending: false });
        setClasses(((sessions as SessionRow[] | null) ?? []).filter((session) => new Date(session.ends_at).getTime() > Date.now()));
      }
      setReady(true);
    }
    load();
  }, []);

  if (!ready) {
    return <div className="grid min-h-screen place-items-center"><p className="serif text-4xl">Opening classes…</p></div>;
  }

  return (
    <Shell kicker={profile?.role === "organiser" ? "Organiser" : "Student"}>
      <h1 className="serif mt-3 text-5xl">Join a class</h1>
      {profile?.role === "organiser" ? (
        <div className="mt-6 max-w-lg">
          <p className="text-lg text-ink/70">Only a student account can join a class. Your account can create one.</p>
          <Link href="/create" className="btn btn-ink mt-6">Create a class</Link>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {classes.length === 0 && <p className="text-ink/70">No class is live right now. Ask the organiser to start one, then come back.</p>}
          {classes.map((session) => (
            <div key={session.id} className="panel flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <p className="font-medium">{session.title}</p>
                <p className="text-sm text-ink/50">{session.course}</p>
              </div>
              <Link href={`/room/${session.id}`} className="btn btn-ink px-4 py-2 text-sm">Join</Link>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
