import type { Metadata } from "next";
import { GoLiveReadinessPage } from "@/components/go-live-readiness-page";

export const metadata: Metadata = {
  title: "Go-Live Readiness",
};

export default function Page() {
  return <GoLiveReadinessPage />;
}
