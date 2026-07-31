#!/usr/bin/env node
// Read-only report: for every project, show every go-live-date-like signal
// and what lib/project-dates.ts's resolveGoLiveDate() would select.
//
// This script NEVER writes anything — it has no insert/update/delete calls
// against Supabase, local storage, or any file. It is safe to run at any
// time. By default it reads the local lib/seed-data.ts fixture; it only
// reads from Supabase if NEXT_PUBLIC_SUPABASE_URL and a key
// (SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY) are present
// in the environment — plain `node` does not load .env.local, so running
// this without exporting those variables yourself always uses the local
// fixture.
//
// Usage: node scripts/report-go-live-dates.mjs
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    const target = path.join(root, request.slice(2));
    for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts"), target]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

Module._extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};

const req = Module.createRequire(import.meta.url);
const { resolveGoLiveDate } = req("../lib/project-dates.ts");
const { schemaTables } = req("../lib/schema.ts");

async function loadDataStore() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.log("[report-go-live-dates] No Supabase env vars found — reading lib/seed-data.ts (read-only, local fixture).\n");
    const { seedData } = req("../lib/seed-data.ts");
    return seedData;
  }

  console.log(`[report-go-live-dates] Reading LIVE data from ${url} (read-only SELECT queries only, no writes).\n`);
  const { createClient } = req("@supabase/supabase-js");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const tableNames = schemaTables.map((table) => table.name);
  const entries = await Promise.all(
    tableNames.map(async (table) => {
      const { data, error } = await client.from(table).select("*");
      if (error) throw new Error(`Failed to read ${table}: ${error.message}`);
      return [table, data ?? []];
    }),
  );
  return Object.fromEntries(entries);
}

function formatConflicts(conflicts) {
  if (!conflicts.length) return "";
  return conflicts.map((conflict) => `${conflict.source}=${conflict.date} (${conflict.detail})`).join("; ");
}

async function main() {
  const data = await loadDataStore();
  const rows = data.projects.map((project) => {
    const resolution = resolveGoLiveDate(data, project);
    const milestone = (data.milestones ?? []).find(
      (item) => item.project_id === project.id && /go.?live/i.test(item.title) && item.target_date,
    );

    return {
      "Project ID": project.id,
      "Project Name": project.name,
      "Milestone Go-Live Date": milestone ? `${milestone.target_date} ("${milestone.title}")` : "(none)",
      "project.go_live_date": project.go_live_date ?? "(none)",
      "planned_end_date": project.planned_end_date ?? "(none)",
      "Selected Date": resolution.date ?? "(none)",
      "Selected Source": resolution.source,
      "Conflict?": resolution.conflicts.length > 0 ? "YES" : "no",
      "Conflicting Values": formatConflicts(resolution.conflicts),
    };
  });

  console.table(rows);

  const conflictCount = rows.filter((row) => row["Conflict?"] === "YES").length;
  console.log(`\n${rows.length} project(s) checked, ${conflictCount} with at least one date-source conflict.`);
  console.log("This report changed nothing — no project data was written.\n");
}

main().catch((error) => {
  console.error("[report-go-live-dates] failed:", error.message ?? error);
  process.exitCode = 1;
});
