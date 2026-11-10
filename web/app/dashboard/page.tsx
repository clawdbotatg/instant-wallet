import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

/** Totals over every Instant Wallet, admins only (lib/dash.ts). */
export default function Page() {
  return <Dashboard />;
}
