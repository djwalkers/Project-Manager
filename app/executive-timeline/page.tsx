import type { Metadata } from "next";
import { ExecutiveTimelinePage } from "@/components/executive-timeline-page";

export const metadata: Metadata = {
  title: "Executive Timeline",
};

export default function Page() {
  return <ExecutiveTimelinePage />;
}
