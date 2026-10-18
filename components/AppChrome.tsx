"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { inNativeApp } from "@/lib/ble";
import { getDebugLog, installDebugFetch, subscribeDebug, type DebugEntry } from "@/lib/debug";

export default function AppChrome() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DebugEntry[]>([]);

  useEffect(() => {
    installDebugFetch();
    setRows(getDebugLog());
    const unsubscribe = subscribeDebug(() => setRows(getDebugLog()));
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    inNativeApp().then((native) => {
      document.documentElement.classList.toggle("app-native", native);
    });
  }, []);

  const home = path === "/";

  return (
    <>
      {!home && (
        <Link href="/" className="btn btn-ink fixed bottom-4 left-4 z-40 px-4 py-2 text-sm">
          Main screen
        </Link>
      )}
      <button
        type="button"
        className="btn btn-ghost fixed bottom-4 right-4 z-40 px-4 py-2 text-sm"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide debug" : "Debug"}
      </button>
      {open && (
        <section className="fixed inset-x-3 bottom-16 z-40 max-h-[50vh] overflow-hidden rounded-3xl border border-ink/15 bg-ink text-foam shadow-xl">
          <div className="flex items-center justify-between px-4 py-3">
            <p className="text-sm font-medium">Backend console</p>
            <button
              type="button"
              className="text-xs underline"
              onClick={() => {
                const text = rows.map((row) => `${row.at} [${row.source}] ${row.message} ${row.detail || ""}`).join("\n");
                void navigator.clipboard?.writeText(text);
              }}
            >
              Copy
            </button>
          </div>
          <div className="max-h-[40vh] space-y-2 overflow-y-auto px-4 pb-4 font-mono text-[11px] leading-relaxed">
            {rows.length === 0 && <p className="text-foam/60">No server calls yet. Join a class or start one, then watch this list.</p>}
            {rows.slice().reverse().map((row, index) => (
              <p key={`${row.at}-${index}`}>
                <span className="text-foam/50">{row.at}</span> [{row.source}] {row.message}
                {row.detail ? <span className="block whitespace-pre-wrap text-foam/70">{row.detail}</span> : null}
              </p>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
