import type { Metadata } from "next";
import { DeskLoginClient } from "./DeskLoginClient";

export const metadata: Metadata = {
  title: "Desk sign in · Munshi",
  description: "Sign in to approve Munshi write actions.",
};

export default function DeskLoginPage() {
  return <DeskLoginClient />;
}
