export type Role = "organiser" | "student";

export type Profile = {
  id: string;
  full_name: string;
  role: Role;
  student_code: string | null;
  created_at: string;
};

export type DeviceRow = {
  id: string;
  user_id: string;
  label: string | null;
  status: "pending" | "active" | "revoked";
  created_at: string;
  reviewed_at: string | null;
};

export type SessionRow = {
  id: string;
  organiser_id: string;
  title: string;
  course: string;
  duration_seconds: number;
  started_at: string;
  ends_at: string;
  status: "live" | "closed";
  radius_meters: number;
  last_beacon_at: string | null;
  created_at: string;
};

export type AttendanceRow = {
  id: string;
  session_id: string;
  student_id: string;
  device_id: string | null;
  marked_at: string;
  rssi: number | null;
  distance_meters: number | null;
  method: "auto" | "manual";
  token_epoch: number | null;
  presence: "present" | "grace" | "absent" | "joined";
  last_seen_at: string | null;
  grace_until: string | null;
  absent_at: string | null;
};

export type MarkResult = {
  ok: boolean;
  reason: string;
  distance?: number | string | null;
  seconds?: number;
  epoch?: number;
  session_id?: string;
  rssi?: number;
  message?: string;
  title?: string;
  course?: string;
};

export const SESSION_COLUMNS =
  "id, organiser_id, title, course, duration_seconds, started_at, ends_at, status, radius_meters, last_beacon_at, created_at";

export const PROFILE_COLUMNS = "id, full_name, role, student_code, created_at";

export const ATTENDANCE_COLUMNS =
  "id, session_id, student_id, device_id, marked_at, rssi, distance_meters, method, token_epoch, presence, last_seen_at, grace_until, absent_at";

export const DEVICE_COLUMNS = "id, user_id, label, status, created_at, reviewed_at";
