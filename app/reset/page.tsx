"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setReady(true);
    });
    supabase.auth.getSession().then(({ data: sessionData }) => {
      if (sessionData.session) setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setPending(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.push("/room");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5">
      <Link href="/" className="text-lg font-semibold">ProxyProof</Link>
      <h1 className="serif mt-8 text-5xl">Choose a new password</h1>
      {!ready && <p className="mt-4 text-ink/70">Open the link from the reset email to continue.</p>}
      {ready && (
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block">
            <span className="eyebrow text-ink/50">New password</span>
            <input className="field mt-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} autoComplete="new-password" />
          </label>
          {error && <p className="rounded-2xl bg-coral/10 px-4 py-3 text-sm">{error}</p>}
          <button className="btn btn-ink w-full" disabled={pending}>{pending ? "Saving…" : "Save password"}</button>
        </form>
      )}
    </main>
  );
}
