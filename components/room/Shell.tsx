"use client";

import Link from "next/link";
import { useRoom } from "./RoomProvider";

export default function Shell({
  children,
  kicker,
}: {
  children: React.ReactNode;
  kicker?: string;
}) {
  const { profile, email, signOut } = useRoom();

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/room" className="text-lg font-semibold tracking-tight">
          ProxyProof
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <div className="min-w-0 text-right">
            <p className="truncate font-medium">{profile?.full_name}</p>
            <p className="truncate text-ink/50">{profile?.student_code || email}</p>
          </div>
          <button type="button" onClick={signOut} className="btn btn-ghost px-4 py-2 text-sm">
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 pb-20">
        {kicker && <p className="eyebrow text-ink/50">{kicker}</p>}
        {children}
      </main>
    </div>
  );
}
