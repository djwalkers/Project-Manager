// Phase D — tiny pure helpers pulled out of components/local-ai-assistant-page.tsx
// so the send-disabled and project-change-reset rules are independently
// testable without rendering React.
import type { GatewayReadiness } from "@/lib/ai/local-gateway-client";

export type AssistantReadiness = "not-ollama-provider" | GatewayReadiness;

/**
 * Layers the "is Ollama even the selected provider" gate on top of the pure
 * gateway-health readiness (classifyGatewayReadiness) — if it isn't, the
 * page must never attempt a local connection at all (requirement 3).
 */
export function resolveAssistantReadiness(isOllamaProvider: boolean, gatewayReadiness: GatewayReadiness): AssistantReadiness {
  return isOllamaProvider ? gatewayReadiness : "not-ollama-provider";
}

export function canSendQuestion(params: {
  readiness: AssistantReadiness;
  projectId: string | null;
  question: string;
  sending: boolean;
}): boolean {
  return params.readiness === "ready"
    && params.projectId !== null
    && params.question.trim().length > 0
    && !params.sending;
}

/** True exactly when the selected project has genuinely changed (not on first mount). */
export function shouldResetConversation(previousProjectId: string | null, nextProjectId: string | null): boolean {
  return previousProjectId !== null && previousProjectId !== nextProjectId;
}
