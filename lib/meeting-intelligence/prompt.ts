import type { DataStore } from "@/lib/data-store";
import { scopeProjectData, selectActiveProject } from "@/lib/project-scope";

// Compute rejection rates from past suggestions to bias the prompt
function computeFeedbackBias(data: DataStore, projectId: string): string {
  const allSuggestions = (data.meeting_suggestions ?? []).filter(
    (s) => s.project_id === projectId,
  );
  if (allSuggestions.length < 5) return "";

  const counts: Record<string, { total: number; rejected: number }> = {};
  for (const s of allSuggestions) {
    const k = s.entity_type;
    if (!counts[k]) counts[k] = { total: 0, rejected: 0 };
    counts[k].total++;
  }
  for (const s of allSuggestions.filter((s) => s.status === "Rejected")) {
    if (counts[s.entity_type]) counts[s.entity_type].rejected++;
  }

  const biasLines = Object.entries(counts)
    .filter(([, c]) => c.total >= 3 && c.rejected / c.total > 0.5)
    .map(([type]) => `- ${type}: historically over-suggested; be conservative`);

  return biasLines.length
    ? `\nLEARNED PREFERENCES (from past reviews):\n${biasLines.join("\n")}\n`
    : "";
}

function truncate(s: string, max = 80) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Compact project context string — refs + short titles only.
 * Passed with every chunk prompt to keep token count low.
 */
export function buildCompactContext(data: DataStore): string {
  const project = selectActiveProject(data);
  if (!project) return "";
  const scoped = scopeProjectData(data, project);
  const bias = computeFeedbackBias(data, project.id);

  const actions = scoped.actions
    .filter((a) => !["Complete", "Closed"].includes(a.status))
    .slice(0, 15)
    .map((a) => `  ${a.action_ref}: ${truncate(a.description)}${a.owner ? ` [${a.owner}]` : ""}`)
    .join("\n");

  const decisions = scoped.decisions
    .filter((d) => !["Approved", "Closed"].includes(d.status))
    .slice(0, 12)
    .map((d) => `  ${d.decision_ref}: ${truncate(d.question)}`)
    .join("\n");

  const risks = scoped.risks
    .filter((r) => !["Complete", "Closed"].includes(r.status))
    .slice(0, 12)
    .map((r) => `  ${r.risk_ref}: ${truncate(r.description)} [${r.impact}]`)
    .join("\n");

  const queries = scoped.discovery_questions
    .filter((q) => !["Answered", "Closed"].includes(q.status))
    .slice(0, 12)
    .map((q) => `  ${q.question_ref}: ${truncate(q.question)}`)
    .join("\n");

  const requirements = scoped.requirements
    .slice(0, 12)
    .map((r) => `  ${r.requirement_ref}: ${truncate(r.title)}`)
    .join("\n");

  const milestones = scoped.milestones
    .filter((m) => !["Complete", "Closed"].includes(m.status))
    .slice(0, 10)
    .map((m) => `  ${m.milestone_ref}: ${truncate(m.title)}${m.target_date ? ` [due ${m.target_date}]` : ""}`)
    .join("\n");

  const dependencies = scoped.dependencies
    .filter((d) => !["Complete", "Closed"].includes(d.status))
    .slice(0, 10)
    .map((d) => `  ${truncate(d.name)}`)
    .join("\n");

  return `PROJECT: ${project.name}
CUSTOMER: ${project.customer}
WORKSTREAM: ${project.workstream}
${bias}
OPEN RECORDS (use these refs when suggesting updates/closes):

Actions:
${actions || "  (none)"}

Decisions:
${decisions || "  (none)"}

Risks:
${risks || "  (none)"}

Discovery Questions:
${queries || "  (none)"}

Requirements:
${requirements || "  (none)"}

Milestones:
${milestones || "  (none)"}

Dependencies:
${dependencies || "  (none)"}`;
}

/**
 * System prompt for a single chunk of meeting notes.
 * The provider appends the actual meeting text after this.
 */
export function buildChunkPrompt(
  compactContext: string,
  chunkIndex: number,
  totalChunks: number,
): string {
  const chunkNote =
    totalChunks > 1
      ? `\nNOTE: You are analysing chunk ${chunkIndex + 1} of ${totalChunks} of a larger meeting. Focus only on what is explicitly present in the section below. Be specific — other chunks cover the rest of the meeting.\n`
      : "";

  return `You are an expert project manager assistant. Analyse the provided meeting notes and identify actionable project updates.
${chunkNote}
${compactContext}

INSTRUCTIONS:
1. Read the meeting notes carefully.
2. Identify concrete, actionable updates to project records.
3. If a similar record already exists (check refs above), use action="update" or action="close" with the existing ref.
4. Only suggest "create" if no similar record exists.
5. Assign confidence: High = explicitly stated, Medium = implied, Low = speculative.
6. Be specific — generic suggestions like "discuss further" are not useful.
7. Keep titles concise (under 80 characters).
8. For data_payload, suggest realistic field values:
   - Actions: description, owner, due_date (YYYY-MM-DD), priority (High/Medium/Low), status
   - Decisions: question, decision_text, owner, due_date, status
   - Risks: description, impact (High/Medium/Low/Critical), probability (High/Medium/Low), mitigation, status
   - Discovery Questions: question, status, owner
   - Requirements: title, description, priority, status, category
   - Milestones: title, target_date, status
   - Dependencies: name, description, owner, status`;
}
