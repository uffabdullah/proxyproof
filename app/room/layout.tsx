import { RoomProvider } from "@/components/room/RoomProvider";

export default function RoomLayout({ children }: { children: React.ReactNode }) {
  return <RoomProvider>{children}</RoomProvider>;
}
