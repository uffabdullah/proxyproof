"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AccountFrame from "@/components/AccountFrame";
import { createClient } from "@/lib/supabase/client";
import { PROFILE_COLUMNS, type Profile } from "@/lib/types";

export default function CreatePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    async function load() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;
      const { data } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", userData.user.id).maybeSingle();
      const next = data as Profile | null;
      if (next?.role === "organiser") router.replace("/room");
      else setReady(true);
    }
    load();
  }, [router]);

  if (!ready) {
    return <div className="grid min-h-screen place-items-center"><p className="serif text-4xl">Checking your account…</p></div>;
  }

  return (
    <AccountFrame kicker="Student">
      <h1 className="serif mt-3 text-5xl">Create a class</h1>
      <p className="mt-4 max-w-lg text-lg text-ink/70">
        Only an organiser account can start a class. You are signed in as a student, so you can join one instead.
      </p>
      <Link href="/join" className="btn btn-ink mt-6">Join a class</Link>
    </AccountFrame>
  );
}
