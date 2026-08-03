"use client";

// Phase D — Local Ollama Project Assistant UX.
//
// Read-only by construction: this file (and lib/ai/local-gateway-client.ts)
// never imports createRecord/updateRecord/saveRecord/upsertRecord/
// deleteRecord or any Supabase service-role client. If a question asks the
// assistant to change something, the model may only explain or draft text
// — there is no button anywhere in this UI that applies a change.
//
// Every gateway call (health check, streaming completion) goes straight
// from this browser to the local gateway's own loopback origin — never
// through a Vercel/Next.js API route. The one Next.js route this page does
// call, GET /api/ai-settings, only ever returns safe, non-secret metadata
// (provider/model/gateway URL) — the same route app/ai-settings/page.tsx
// already uses — not anything AI-inference-related.
import {
  AlertTriangle, Bot, CheckCircle2, ChevronRight, Copy, ExternalLink, Loader2,
  MessageCircle, RefreshCw, RotateCcw, Send, ShieldAlert, Square, Trash2, XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import {
  buildProjectAssistantDTO, type ProjectAssistantDTO,
} from "@/lib/ai/project-assistant-dto";
import {
  checkGatewayHealth, classifyGatewayReadiness, describeGatewayError, streamProjectAssistant,
  type DoneEvent, type GatewayHealth,
} from "@/lib/ai/local-gateway-client";
import { canSendQuestion, resolveAssistantReadiness, shouldResetConversation, type AssistantReadiness } from "@/lib/ai/assistant-state";
import { parseFeasibilityAnswer, type FeasibilityAnswer } from "@/lib/ai/feasibility-answer";
import { sourceRefHref } from "@/lib/ai/source-refs";
import { loadSelectedProjectId, persistSelectedProjectId } from "@/lib/project-selection";
import { selectCanonicalProjects, selectProjectById } from "@/lib/project-scope";
import { useProjectData } from "@/lib/use-project-data";
import { cn } from "@/lib/utils";

// Mirrors app/ai-settings/page.tsx's own local AIMeta type rather than
// importing lib/ai/settings.ts — that module is explicitly server-only and
// must never be imported from a client component (see its own doc comment).
type AIProviderName = "none" | "openai" | "gemini" | "anthropic" | "ollama";
type AISettingsMeta = {
  id: string | null;
  provider: AIProviderName;
  model: string | null;
  local_gateway_url: string | null;
  enabled: boolean;
  key_configured: boolean;
};

const SUGGESTED_QUESTIONS = [
  "Why is this project Amber?",
  "Is the current Go-Live date achievable?",
  "What is preventing UAT sign-off?",
  "What remains before Go Live?",
  "Explain the Delivery Confidence score.",
  "Which outstanding items are customer-owned?",
  "What should I focus on today?",
  "Summarise this project for a steering meeting.",
  "Draft a customer status update.",
];

type ChatMessage = {
  id: string;
  question: string;
  answerText: string;
  status: "streaming" | "done" | "error" | "cancelled";
  done: DoneEvent | null;
  errorMessage: string | null;
};

function createMessageId() {
  return `msg-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// ── Inline "markdown-lite" rendering — no dependency, no HTML injection ────
// Supports paragraphs, "- " bullet lists, **bold**, and `inline code` only.
// Long lines wrap; nothing here can overflow the page horizontally.
function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter((p) => p.length > 0);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <code key={`${keyPrefix}-${i}`} className="rounded bg-muted px-1 py-0.5 font-mono text-[13px] break-all">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function MarkdownLite({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2.5">
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim().length > 0);
        const isList = lines.length > 0 && lines.every((l) => /^\s*[-*]\s+/.test(l));
        if (isList) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {lines.map((line, li) => (
                <li key={li} className="break-words">{renderInline(line.replace(/^\s*[-*]\s+/, ""), `${bi}-${li}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} className="whitespace-pre-wrap break-words">
            {lines.map((line, li) => (
              <span key={li}>
                {renderInline(line, `${bi}-${li}`)}
                {li < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// ── Sources ──────────────────────────────────────────────────────────────────

function SourceBadges({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Sources:</span>
      {refs.map((ref) => {
        const href = sourceRefHref(ref);
        const badge = (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono font-medium text-foreground">{ref}</span>
        );
        return href ? (
          <Link key={ref} href={href} className="hover:opacity-75">{badge}</Link>
        ) : (
          <span key={ref}>{badge}</span>
        );
      })}
    </div>
  );
}

function UnverifiedCitationWarning({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <div role="alert" className="mt-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">The model referenced information that was not present in the supplied project context.</p>
        <p className="mt-1 font-mono">{refs.join(", ")}</p>
      </div>
    </div>
  );
}

// ── Feasibility rendering (requirement 9) ───────────────────────────────────

const FEASIBILITY_FIELDS: Array<{ key: keyof FeasibilityAnswer; label: string }> = [
  { key: "assessment", label: "Assessment" },
  { key: "confidence", label: "Confidence" },
  { key: "supportingEvidence", label: "Supporting evidence" },
  { key: "threatsAndDependencies", label: "Threats and dependencies" },
  { key: "assumptions", label: "Assumptions" },
  { key: "recommendedNextAction", label: "Recommended next action" },
];

function FeasibilityView({ answer }: { answer: FeasibilityAnswer }) {
  return (
    <dl className="space-y-2.5">
      {FEASIBILITY_FIELDS.map(({ key, label }) => (
        <div key={key}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm">{answer[key] || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Connection status (requirement 3) ────────────────────────────────────────

const READINESS_LABEL: Record<AssistantReadiness, string> = {
  "not-ollama-provider": "Local Ollama is not the selected AI provider",
  checking: "Checking the local gateway…",
  "gateway-unavailable": "Local gateway unavailable",
  "ollama-unavailable": "Gateway reachable, but Ollama isn't running",
  "model-unavailable": "Configured model unavailable",
  ready: "Ready",
};

function ConnectionStatus({
  readiness, gatewayUrl, model, health, lastChecked, checking, onRecheck,
}: {
  readiness: AssistantReadiness;
  gatewayUrl: string | null;
  model: string | null;
  health: GatewayHealth | null;
  lastChecked: Date | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  const ready = readiness === "ready";
  const Icon = ready ? CheckCircle2 : readiness === "checking" ? Loader2 : readiness === "not-ollama-provider" ? Bot : AlertTriangle;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-lg border p-4",
        ready ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30"
          : readiness === "checking" ? "border-muted-foreground/20 bg-muted/30"
            : "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Icon className={cn("mt-0.5 h-4.5 w-4.5 shrink-0", readiness === "checking" && "animate-spin", ready ? "text-emerald-600" : readiness === "checking" ? "text-muted-foreground" : "text-amber-600")} aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">{READINESS_LABEL[readiness]}</p>
            {readiness === "not-ollama-provider" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Select Local Ollama as the AI provider to use this assistant.{" "}
                <Link href="/ai-settings" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                  Go to AI Settings <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Link>
              </p>
            ) : readiness === "gateway-unavailable" ? (
              <p className="mt-1 text-xs text-muted-foreground">Start the gateway on this Mac (<code className="rounded bg-muted px-1 font-mono">npm start</code> in <code className="rounded bg-muted px-1 font-mono">local-gateway/</code>), then Recheck. If Chrome just asked for Local Network Access, click Allow.</p>
            ) : readiness === "ollama-unavailable" ? (
              <p className="mt-1 text-xs text-muted-foreground">The gateway is reachable but reports Ollama as down. Make sure Ollama is running on this Mac.</p>
            ) : readiness === "model-unavailable" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                &quot;{model}&quot; isn&apos;t installed in Ollama or isn&apos;t allow-listed on the gateway.{" "}
                <Link href="/ai-settings" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                  Go to AI Settings <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Link>
              </p>
            ) : null}
          </div>
        </div>
        {readiness !== "not-ollama-provider" && (
          <Button size="sm" variant="outline" onClick={onRecheck} disabled={checking} className="shrink-0 gap-1.5">
            <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} aria-hidden="true" />
            Recheck
          </Button>
        )}
      </div>

      {readiness !== "not-ollama-provider" && (
        <dl className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Gateway URL</dt>
            <dd className="mt-0.5 truncate font-mono" title={gatewayUrl ?? undefined}>{gatewayUrl ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Model</dt>
            <dd className="mt-0.5 truncate font-mono">{model || "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Installed models</dt>
            <dd className="mt-0.5">{health ? health.models.length : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last checked</dt>
            <dd className="mt-0.5">{lastChecked ? lastChecked.toLocaleTimeString("en-GB") : "Not checked yet"}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

// ── Chat message ─────────────────────────────────────────────────────────────

function ChatMessageView({
  message, onRetry, onCopy,
}: {
  message: ChatMessage;
  onRetry: (id: string) => void;
  onCopy: (text: string) => void;
}) {
  const feasibility = message.status === "done" && message.done?.answerType === "feasibility"
    ? parseFeasibilityAnswer(message.answerText)
    : null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">You asked</p>
        <p className="mt-0.5 whitespace-pre-wrap break-words">{message.question}</p>
      </div>

      <div className="rounded-lg border bg-card p-3.5 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Bot className="h-3.5 w-3.5" aria-hidden="true" /> Assistant
          {message.status === "streaming" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
        </div>

        <div className="mt-2 min-h-[1.5rem] text-sm" aria-live={message.status === "streaming" ? "polite" : undefined}>
          {feasibility ? <FeasibilityView answer={feasibility} /> : <MarkdownLite text={message.answerText || (message.status === "streaming" ? "" : "(no response)")} />}
        </div>

        {message.status === "done" && message.done && (
          <>
            <SourceBadges refs={message.done.validatedSources} />
            <UnverifiedCitationWarning refs={message.done.unverifiedCitations} />
          </>
        )}

        {message.status === "error" && (
          <div role="alert" className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {message.errorMessage}
          </div>
        )}

        {message.status === "cancelled" && (
          <p className="mt-2 text-xs text-muted-foreground">Cancelled.</p>
        )}

        {message.status !== "streaming" && (
          <div className="mt-3 flex items-center gap-3 border-t pt-2">
            <button className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => onCopy(message.answerText)}>
              <Copy className="h-3 w-3" aria-hidden="true" /> Copy
            </button>
            <button className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => onRetry(message.id)}>
              <RotateCcw className="h-3 w-3" aria-hidden="true" /> Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function LocalAIAssistantPage() {
  const { user } = useAuth();
  const allowed = user?.role === "Admin" || user?.role === "Manager" || user?.role === undefined; // undefined = local dev, no auth backend

  const { data, error, reload } = useProjectData();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  useEffect(() => { setSelectedProjectId(loadSelectedProjectId()); }, []);

  const projects = useMemo(() => (data ? selectCanonicalProjects(data) : []), [data]);
  const project = useMemo(() => (data ? selectProjectById(data, selectedProjectId) : null), [data, selectedProjectId]);

  const handleProjectChange = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    persistSelectedProjectId(projectId);
  }, []);

  // ── AI Settings metadata (safe, non-secret — same route AI Settings itself uses) ──
  const [aiMeta, setAiMeta] = useState<AISettingsMeta | null>(null);
  const [aiMetaLoading, setAiMetaLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/ai-settings");
        if (res.ok) setAiMeta(await res.json() as AISettingsMeta);
      } finally {
        setAiMetaLoading(false);
      }
    })();
  }, []);

  // ── Gateway health ────────────────────────────────────────────────────────
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthError, setHealthError] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const gatewayUrl = aiMeta?.local_gateway_url ?? null;
  const model = aiMeta?.model ?? null;
  const isOllamaProvider = aiMeta?.provider === "ollama";

  const runHealthCheck = useCallback(async () => {
    if (!gatewayUrl) return;
    setHealthChecking(true);
    setHealthError(false);
    try {
      const result = await checkGatewayHealth(gatewayUrl);
      setHealth(result);
    } catch {
      setHealth(null);
      setHealthError(true);
    } finally {
      setHealthChecking(false);
      setLastChecked(new Date());
    }
  }, [gatewayUrl]);

  useEffect(() => {
    if (isOllamaProvider && gatewayUrl) void runHealthCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOllamaProvider, gatewayUrl]);

  const gatewayReadiness = classifyGatewayReadiness({ checking: healthChecking, health, hadError: healthError, model: model ?? "" });
  const readiness: AssistantReadiness = resolveAssistantReadiness(isOllamaProvider, gatewayReadiness);

  // ── DTO — one explicit project, rebuilt on project change or data refresh ──
  const dtoResult = useMemo(() => {
    if (!data || !project) return null;
    const generatedAt = new Date();
    return { dto: buildProjectAssistantDTO(data, project, generatedAt), builtAt: generatedAt };
  }, [data, project]);

  async function refreshProjectData() {
    reload();
  }

  // ── Conversation ─────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const prevProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    const nextId = project?.id ?? null;
    if (shouldResetConversation(prevProjectIdRef.current, nextId)) {
      abortRef.current?.abort();
      setMessages([]);
    }
    prevProjectIdRef.current = nextId;
  }, [project]);

  const send = useCallback(async (questionText: string, existingMessageId?: string) => {
    if (!dtoResult || !model) return;
    const id = existingMessageId ?? createMessageId();
    const message: ChatMessage = { id, question: questionText, answerText: "", status: "streaming", done: null, errorMessage: null };
    setMessages((prev) => (existingMessageId ? prev.map((m) => (m.id === id ? message : m)) : [...prev, message]));

    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);

    const update = (patch: Partial<ChatMessage>) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    };

    try {
      await streamProjectAssistant(
        { gatewayUrl: gatewayUrl ?? "", model, question: questionText, dto: dtoResult.dto as ProjectAssistantDTO, signal: controller.signal },
        {
          onToken: (text) => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, answerText: m.answerText + text } : m))),
          onDone: (event) => update({ status: "done", done: event }),
          onError: (event) => update({ status: "error", errorMessage: describeGatewayError(event.code) }),
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        update({ status: "cancelled" });
      } else {
        update({ status: "error", errorMessage: "Something went wrong sending this question to the local gateway." });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [dtoResult, gatewayUrl, model]);

  function handleSend() {
    const text = question.trim();
    if (!canSendQuestion({ readiness, projectId: project?.id ?? null, question: text, sending })) return;
    setQuestion("");
    void send(text);
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  function handleRetry(messageId: string) {
    const target = messages.find((m) => m.id === messageId);
    if (!target || sending) return;
    void send(target.question, messageId);
  }

  function handleCopy(text: string) {
    void navigator.clipboard?.writeText(text);
  }

  function handleClearConversation() {
    abortRef.current?.abort();
    setMessages([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!allowed) {
    return (
      <AppShell>
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <p className="font-medium text-destructive">Access restricted</p>
            <p className="mt-1 text-sm text-muted-foreground">Only Admin and Manager users can use the Local AI Assistant.</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data || aiMetaLoading) return <AppShell><LoadingState /></AppShell>;

  const sendDisabled = !canSendQuestion({ readiness, projectId: project?.id ?? null, question: question.trim(), sending });

  return (
    <AppShell>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Intelligence</p>
          <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold"><MessageCircle className="h-6 w-6 text-primary" aria-hidden="true" /> Local AI Assistant</h2>
          <p className="mt-1 text-sm text-muted-foreground">Ask about this project&apos;s status, using a local Ollama model on this Mac.</p>
        </div>
        {projects.length > 1 && (
          <Select value={project?.id ?? ""} onChange={(e) => handleProjectChange(e.target.value)} className="w-full sm:w-64">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
      </div>

      <div role="alert" className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
        Read-only assistant. It can explain, recommend and draft, but it cannot change project data.
      </div>

      <div className="mt-4">
        <ConnectionStatus
          readiness={readiness}
          gatewayUrl={gatewayUrl}
          model={model}
          health={health}
          lastChecked={lastChecked}
          checking={healthChecking}
          onRecheck={() => void runHealthCheck()}
        />
      </div>

      {!project ? (
        <div className="mt-8 text-center text-sm text-muted-foreground">No projects found.</div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <p aria-live="polite">
              Answers reflect project data loaded at {dtoResult ? dtoResult.builtAt.toLocaleTimeString("en-GB") : "—"}
            </p>
            <Button size="sm" variant="ghost" onClick={() => void refreshProjectData()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh Project Data
            </Button>
          </div>

          {/* Suggested questions */}
          <div className="mt-3 flex flex-wrap gap-2">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => setQuestion(q)}
                className="rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
              >
                {q}
              </button>
            ))}
          </div>

          {/* Conversation */}
          <div className="mt-4 space-y-4">
            {messages.length === 0 ? (
              <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                Ask a question above or pick a suggested one to get started.
              </div>
            ) : (
              messages.map((m) => <ChatMessageView key={m.id} message={m} onRetry={handleRetry} onCopy={handleCopy} />)
            )}
          </div>

          {/* Input */}
          <div className="sticky bottom-0 mt-4 rounded-lg border bg-card p-3 shadow-operational">
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this project… (Enter to send, Shift+Enter for a new line)"
              className="min-h-20 resize-none"
              aria-label="Question for the local AI assistant"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                onClick={handleClearConversation}
                disabled={messages.length === 0}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Clear conversation
              </button>
              <div className="flex items-center gap-2">
                {sending && (
                  <Button size="sm" variant="outline" onClick={handleCancel} className="gap-1.5">
                    <Square className="h-3.5 w-3.5" aria-hidden="true" /> Cancel
                  </Button>
                )}
                <Button size="sm" onClick={handleSend} disabled={sendDisabled} className="gap-1.5">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                  Send
                </Button>
              </div>
            </div>
            {readiness !== "ready" && (
              <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                <ChevronRight className="h-3 w-3" aria-hidden="true" /> Sending is disabled until the local gateway is Ready.
              </p>
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}
