import type { ArtefactLink } from "@/lib/types";

let supabase: ReturnType<typeof import("@supabase/supabase-js").createClient> | null = null;

async function getClient() {
  if (supabase) return supabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const { createClient } = await import("@supabase/supabase-js");
  supabase = createClient(url, key);
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
  const { data } = await (client.from("artefact_links") as any).insert(link).select().single();
  return data as ArtefactLink | null;
}

export async function removeLink(id: string): Promise<void> {
  const client = await getClient();
  if (!client) return;
  await client.from("artefact_links").delete().eq("id", id);
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
