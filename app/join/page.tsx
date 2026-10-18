"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AccountFrame from "@/components/AccountFrame";
import { createClient } from "@/lib/supabase/client";
import { PROFILE_COLUMNS, SESSION_COLUMNS, type Profile, type SessionRow } from "@/lib/types";

export default function JoinPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [classes, setClasses] = useState<SessionRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    async function load() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;
      const { data } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", userData.user.id).maybeSingle();
      const next = data as Profile | null;
      setProfile(next);
      await supabase.rpc("sweep_sessions");
      const { data: sessions } = await supabase.from("sessions").select(SESSION_COLUMNS).eq("status", "live").order("started_at", { ascending: false });
      const live = ((sessions as SessionRow[] | null) ?? []).filter((session) => new Date(session.ends_at).getTime() > Date.now());
      setClasses(live);
      const ids = live.map((session) => session.organiser_id);
      const nextNames: Record<string, string> = {};
      if (ids.length > 0) {
        const { data: people } = await supabase.from("profiles").select(PROFILE_COLUMNS).in("id", ids);
        ((people as Profile[] | null) ?? []).forEach((person) => {
          nextNames[person.id] = person.full_name;
        });
      }
      setNames(nextNames);
      setReady(true);
    }
    load();
  }, []);

  async function openClass(session: SessionRow) {
    if (profile?.role === "organiser" && session.organiser_id !== profile.id) {
      const supabase = createClient();
      const { error: rpcError } = await supabase.rpc("join_as_host", { p_session_id: session.id });
      if (rpcError) {
        setError(rpcError.message);
        return;
      }
    }
    router.push(`/room/${session.id}`);
  }

  if (!ready) {
    return <div className="grid min-h-screen place-items-center"><p className="serif text-4xl">Opening classes…</p></div>;
  }

  return (
    <AccountFrame kicker={profile?.role === "organiser" ? "Organiser" : "Student"}>
      <h1 className="serif mt-3 text-5xl">Join a class</h1>
      <p className="mt-4 max-w-lg text-lg text-ink/70">
        {profile?.role === "organiser"
          ? "Open your own class, or join another organiser's class as a co-host."
          : "Pick a live class. Stay nearby and you will be marked present."}
      </p>
      {error && <p className="mt-4 rounded-2xl bg-coral/10 px-4 py-3 text-sm">{error}</p>}
      <div className="mt-6 space-y-3">
        {classes.length === 0 && <p className="text-ink/70">No class is live right now.</p>}
        {classes.map((session) => {
          const own = profile?.id === session.organiser_id;
          return (
            <div key={session.id} className="panel flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <p className="font-medium">{session.title}</p>
                <p className="text-sm text-ink/50">{session.course} · {own ? "Your class" : names[session.organiser_id] || "Live now"}</p>
              </div>
              <button type="button" className="btn btn-ink px-4 py-2 text-sm" onClick={() => openClass(session)}>
                {profile?.role === "organiser" ? (own ? "Open" : "Join as co-host") : "Join"}
              </button>
            </div>
          );
        })}
      </div>
      {profile?.role === "organiser" && (
        <Link href="/create" className="btn btn-ghost mt-8">Create a class</Link>
      )}
    </AccountFrame>
  );
}
