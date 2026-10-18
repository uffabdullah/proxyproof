export type DebugEntry = {
  at: string;
  source: string;
  message: string;
  detail?: string;
};

const entries: DebugEntry[] = [];
const listeners = new Set<() => void>();
let installed = false;

function scrub(value: string) {
  return value
    .replace(/p_secret\\?"\s*:\s*\\?"[^"\\]+/g, 'p_secret":"hidden')
    .replace(/access_token\\?"\s*:\s*\\?"[^"\\]+/g, 'access_token":"hidden')
    .replace(/refresh_token\\?"\s*:\s*\\?"[^"\\]+/g, 'refresh_token":"hidden')
    .slice(0, 700);
}

export function logDebug(source: string, message: string, detail?: unknown) {
  const text =
    detail == null ? undefined : typeof detail === "string" ? scrub(detail) : scrub(JSON.stringify(detail));
  entries.push({
    at: new Date().toLocaleTimeString(),
    source,
    message,
    detail: text,
  });
  if (entries.length > 100) entries.shift();
  listeners.forEach((listener) => listener());
}

export function getDebugLog() {
  return entries.slice();
}

export function subscribeDebug(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installDebugFetch() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const interesting = url.includes("supabase.co");
    const started = Date.now();
    try {
      const response = await original(input, init);
      if (interesting) {
        const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        const copy = response.clone();
        const body = await copy.text().catch(() => "");
        logDebug("server", `${response.status} ${init?.method || "GET"} ${path} · ${Date.now() - started}ms`, body);
      }
      return response;
    } catch (error) {
      if (interesting) {
        logDebug("server", `failed ${url}`, error instanceof Error ? error.message : "request failed");
      }
      throw error;
    }
  };
}
