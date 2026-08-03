import type { Metadata } from "next";
import { LocalAIAssistantPage } from "@/components/local-ai-assistant-page";

export const metadata: Metadata = {
  title: "Local AI Assistant | Project Manager",
};

export default function Page() {
  return <LocalAIAssistantPage />;
}
