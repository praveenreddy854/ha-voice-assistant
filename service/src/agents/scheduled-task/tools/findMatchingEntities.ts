import { z } from "zod";
import { fetchAllStates } from "../../../ha";

export const inputSchema = z.object({
  query: z
    .string()
    .describe(
      "Free-text search term, e.g. 'vacuum', 'kitchen light', 'roborock'. Matched against entity_id and friendly_name."
    ),
  domain: z
    .string()
    .optional()
    .describe(
      "Optional Home Assistant domain filter, e.g. 'vacuum', 'light', 'switch', 'media_player'."
    ),
});

export type FindMatchingEntitiesInput = z.infer<typeof inputSchema>;

export interface EntityMatch {
  entityId: string;
  friendlyName: string;
  domain: string;
  state: string;
}

export async function execute(args: FindMatchingEntitiesInput): Promise<{
  matches: EntityMatch[];
  observation: string;
}> {
  const { query, domain } = inputSchema.parse(args);
  const all = await fetchAllStates();
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);

  const matches: EntityMatch[] = all
    .filter((s) => {
      const [d] = s.entity_id.split(".");
      if (domain && d !== domain) return false;
      const friendly = ((s.attributes as Record<string, unknown>)
        ?.friendly_name as string | undefined) || "";
      const haystack = `${s.entity_id} ${friendly}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    })
    .map((s) => ({
      entityId: s.entity_id,
      friendlyName:
        ((s.attributes as Record<string, unknown>)?.friendly_name as
          | string
          | undefined) || s.entity_id,
      domain: s.entity_id.split(".")[0],
      state: s.state,
    }));

  const observation =
    matches.length === 0
      ? `No entities matched "${query}"${domain ? ` in domain "${domain}"` : ""}.`
      : `Found ${matches.length} matching entit${matches.length === 1 ? "y" : "ies"}:\n` +
        matches
          .map(
            (m) =>
              `  - ${m.entityId} (friendly: "${m.friendlyName}", state: ${m.state})`
          )
          .join("\n");

  return { matches, observation };
}

export const definition = {
  name: "find_matching_entities",
  description:
    "Search Home Assistant for entities matching a query. Use this when the user mentions a device by name (e.g. 'vacuum', 'kitchen light') and you need the canonical entity_id. Optionally filter by domain.",
  inputSchema,
};
