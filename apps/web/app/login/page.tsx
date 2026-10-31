import type { Metadata } from "next";
import { LoginClient } from "./LoginClient";

export const metadata: Metadata = {
  title: "Sign in · Munshi",
  description: "Sign in to chat with Munshi about payments, recharges, and refunds.",
};

export default function LoginPage() {
  return <LoginClient />;
}
