import type { Metadata } from "next";
import { ChatClient } from "./ChatClient";

export const metadata: Metadata = {
  title: "Chat with Munshi",
  description: "Tell Munshi what went wrong — it understands, plans, and gets it done.",
};

export default function ChatPage() {
  return <ChatClient />;
}
