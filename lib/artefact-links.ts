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
