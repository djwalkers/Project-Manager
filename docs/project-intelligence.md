# Project Intelligence Engine

Project Intelligence is a deterministic analysis layer available at `/project-intelligence`. It uses existing project-control data only; it does not call an AI service or any external API.

## Output contract

Every finding contains:

- a stable rule ID;
- project and category;
- severity (`Info`, `Warning`, or `Critical`);
- a concise finding and supporting detail;
- the evidence used by the rule;
- a confidence score from 0–100%;
- a recommendation when management action is required.

Info findings are displayed as positive signals. Warning and Critical findings feed the recommendations list and are ordered by severity, confidence, and rule ID.

## Analysed sources

The engine analyses requirements, risks, decisions, actions, discovery questions, milestones, timeline phases, deliverables, test cases, project snapshots, activity log entries, and meetings. System Health validates that every required source is covered and that rule IDs are unique.

## Rule categories

- Schedule: active phase, stalled progress, approaching end date, and variance deterioration.
- Risk: missing mitigation, stale high risks, and increasing risk count.
- Governance: stale decisions, overdue discovery questions, and missing ownership.
- Delivery: development readiness, approaching milestones, deliverable target dates, blockers, and deployment readiness.
- Testing: missing tests, pending-test concentration, and UAT entry readiness.
- Stakeholder: recent activity and meeting cadence.

## Confidence

Confidence is rule-specific and reflects the quality and directness of the available evidence. Direct counts, statuses, due dates, and snapshot comparisons score highest. Inferences from missing or incomplete operating records score lower.

## Trend method

Finding direction uses the two latest project snapshots. A deterministic delivery-pressure score combines open risks, overdue actions, overdue decisions, open questions, and negative schedule variance. The result is reported as Increasing, Decreasing, Stable, or Insufficient history.

## Integrations

- Project Workspace shows the top three Critical and Warning findings.
- Daily Brief includes the five highest-priority recommendations in the page, HTML email, and plain-text email.
- Project Trends shows snapshot-derived intelligence direction.
- System Health validates the rule registry and source coverage.

The engine adds no database tables and requires no migration.
