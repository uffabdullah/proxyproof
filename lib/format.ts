export function formatRemaining(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function ago(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell ?? "";
          if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
          return value;
        })
        .join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function statusCopy(reason: string, distance?: number | string | null) {
  const meters = distance == null || distance === "" ? null : Math.round(Number(distance));
  switch (reason) {
    case "marked":
    case "present":
      return "You're in the room. Stay until the session ends.";
    case "already":
      return "You're on the roster. Location is still being watched.";
    case "grace":
      return "You stepped out. You have a few seconds to return before this becomes an absence.";
    case "absent":
      return "Marked absent. You left during the session.";
    case "silent":
      return "The organiser's phone is not broadcasting Bluetooth.";
    case "far":
      return meters != null
        ? `About ${meters}m from the beacon. Step into the room.`
        : "This phone is not close enough to the beacon.";
    case "fuzzy":
      return "Location is too fuzzy to prove you are in the room.";
    case "noloc":
      return "Allow location so the room can be confirmed.";
    case "weak":
      return "The Bluetooth signal is too weak to count as in the room. Move closer.";
    case "stale":
      return "That token just expired. Listening for the next one.";
    case "pending":
      return "This phone is waiting for organiser approval.";
    case "revoked":
      return "An organiser declined this phone.";
    case "stolen":
      return "This phone is bound to another student.";
    case "unbound":
      return "This phone is not bound yet.";
    case "closed":
      return "This session is closed.";
    default:
      return "Waiting for the beacon.";
  }
}
