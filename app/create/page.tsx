"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { PROFILE_COLUMNS, type Profile } from "@/lib/types";
import Shell from "@/components/room/Shell";

export default function CreatePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    async function load() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;
      const { data } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", userData.user.id).maybeSingle();
      const next = data as Profile | null;
      setProfile(next);
      if (next?.role === "organiser") router.replace("/room");
      else setReady(true);
    }
    load();
  }, [router]);

  if (!ready) {
    return <div className="grid min-h-screen place-items-center"><p className="serif text-4xl">Checking your account…</p></div>;
  }

  return (
    <Shell kicker="Student">
      <h1 className="serif mt-3 text-5xl">Create a class</h1>
      <p className="mt-4 max-w-lg text-lg text-ink/70">
        Only an organiser account can start a class. You are signed in as a student, so you can join one instead.
      </p>
      <Link href="/join" className="btn btn-ink mt-6">Join a class</Link>
    </Shell>
  );
}
