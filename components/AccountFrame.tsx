"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function AccountFrame({
  kicker,
  children,
}: {
  kicker?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          ProxyProof
        </Link>
        <button type="button" onClick={signOut} className="btn btn-ghost px-4 py-2 text-sm">
          Sign out
        </button>
      </header>
      <main className="mx-auto max-w-5xl px-5 pb-20">
        {kicker && <p className="eyebrow text-ink/50">{kicker}</p>}
        {children}
      </main>
    </div>
  );
}
