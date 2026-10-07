import { supabase } from "@/lib/supabase/client";
import type { ArtefactLink } from "@/lib/types";

// artefact_links is the canonical traceability table. Its RLS policy
// (migration 017) lets the `authenticated` role write and `anon` only read,
// so every call here must go through the session-aware browser client
// (@supabase/ssr cookies). The previous standalone anon-key client carried no
// session: inserts were rejected and deletes silently matched zero rows.
async function getClient() {
  return supabase;
}

export async function loadLinksForRecord(
  entity: string,
  id: string,
): Promise<ArtefactLink[]> {
  const client = await getClient();
  if (!client) return [];
  const { data } = await client
    .from("artefact_links")
    .select("*")
    .or(`and(source_entity.eq.${entity},source_id.eq.${id}),and(target_entity.eq.${entity},target_id.eq.${id})`);
  return (data ?? []) as ArtefactLink[];
}

export async function addLink(link: Omit<ArtefactLink, "id" | "created_at">): Promise<ArtefactLink | null> {
  const client = await getClient();
  if (!client) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (client.from("artefact_links") as any).insert(link).select().single();
  if (error) {
    console.error("[artefact-links] Failed to add link:", error.message);
    return null;
  }
  return data as ArtefactLink | null;
}

/** Deletes a link. Throws if the delete fails or matched no row (e.g. blocked by RLS). */
export async function removeLink(id: string): Promise<void> {
  const client = await getClient();
  if (!client) throw new Error("Traceability links are not available without a database connection.");
  const { data, error } = await client.from("artefact_links").delete().eq("id", id).select("id");
  if (error) throw new Error(`Failed to remove link: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Failed to remove link: it was not deleted (it may already be gone, or you are not signed in).");
}

// ── Applying a confirmed link write to the canonical in-memory DataStore ────
// Pure updaters used by the linker's owner via setData, so verification,
// coverage and ProjectState recalculate from the same canonical array.
type WithLinks = { artefact_links?: ArtefactLink[] };

export function withLinkAdded<T extends WithLinks>(data: T, link: ArtefactLink): T {
  return { ...data, artefact_links: [...(data.artefact_links ?? []).filter((l) => l.id !== link.id), link] };
}

export function withLinkRemoved<T extends WithLinks>(data: T, linkId: string): T {
  return { ...data, artefact_links: (data.artefact_links ?? []).filter((l) => l.id !== linkId) };
}

/**
 * Mirrors migration 033's delete trigger in memory: after a Requirement or
 * Acceptance Criterion has been successfully deleted, the database has also
 * removed every artefact_links row pointing at it — drop the same links
 * from the canonical DataStore. Call only after the delete succeeded.
 */
export function withEntityLinksRemoved<T extends WithLinks>(data: T, entity: string, ids: Iterable<string>): T {
  const gone = new Set(ids);
  if (gone.size === 0) return data;
  return {
    ...data,
    artefact_links: (data.artefact_links ?? []).filter((l) =>
      !(l.source_entity === entity && gone.has(l.source_id)) && !(l.target_entity === entity && gone.has(l.target_id))),
  };
}

/**
 * Mirrors migration 049's guard: a link between a promoted test and one of
 * the ACs it was approved against (its source_ac_snapshot) is promotion
 * provenance and cannot be removed — unless another link for the same pair
 * remains. The database is authoritative; this only hides the unlink action.
 */
export function isPromotionLink(link: ArtefactLink, testCases: { id: string; source_ac_snapshot?: { id: string }[] | null }[], links: ArtefactLink[] = []): boolean {
  const pair = (l: ArtefactLink) => (l.source_entity === "test_cases" && l.target_entity === "acceptance_criteria" ? [l.source_id, l.target_id]
    : l.source_entity === "acceptance_criteria" && l.target_entity === "test_cases" ? [l.target_id, l.source_id] : null);
  const p = pair(link);
  if (!p) return false;
  const test = testCases.find((t) => t.id === p[0]);
  if (!test?.source_ac_snapshot?.some((a) => a.id === p[1])) return false;
  return !links.some((l) => l.id !== link.id && pair(l)?.[0] === p[0] && pair(l)?.[1] === p[1]);
}

/** Given a flat list of links for a record, group them by the partner entity. */
export function groupLinksByEntity(
  links: ArtefactLink[],
  ownEntity: string,
  ownId: string,
): Record<string, { linkId: string; partnerId: string }[]> {
  const groups: Record<string, { linkId: string; partnerId: string }[]> = {};
  for (const link of links) {
    const isSource = link.source_entity === ownEntity && link.source_id === ownId;
    const partnerEntity = isSource ? link.target_entity : link.source_entity;
    const partnerId = isSource ? link.target_id : link.source_id;
    if (!groups[partnerEntity]) groups[partnerEntity] = [];
    groups[partnerEntity].push({ linkId: link.id, partnerId });
  }
  return groups;
}
