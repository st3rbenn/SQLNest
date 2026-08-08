/**
 * Schémas Zod des routes `/api/teams/*` (C.21.3).
 */

import z from "zod/v4";
import { TEAM_SLUG_REGEX } from "./slug";

// ─── Params ────────────────────────────────────────────────────────────
export const TeamSlugParams = z.object({
	slug: z.string().regex(TEAM_SLUG_REGEX, "Slug invalide")
});
z.globalRegistry.add(TeamSlugParams, { id: "TeamSlugParams" });
export type TeamSlugParamsT = z.infer<typeof TeamSlugParams>;

// ─── Responses ─────────────────────────────────────────────────────────
export const TeamSummaryResponse = z.object({
	id: z.string(),
	slug: z.string(),
	/** Name stocké — chaîne vide si `isPersonal=true` (frontend affiche
	 *  `${user.name}'s team`). Non-vide pour les teams custom (V2). */
	name: z.string(),
	isPersonal: z.boolean(),
	createdAt: z.string()
});
z.globalRegistry.add(TeamSummaryResponse, { id: "TeamSummaryResponse" });
export type TeamSummaryResponseT = z.infer<typeof TeamSummaryResponse>;

export const ListTeamsResponse = z.object({
	teams: z.array(TeamSummaryResponse)
});
z.globalRegistry.add(ListTeamsResponse, { id: "ListTeamsResponse" });
export type ListTeamsResponseT = z.infer<typeof ListTeamsResponse>;

export const TeamsErrorResponse = z.object({ message: z.string() });
z.globalRegistry.add(TeamsErrorResponse, { id: "TeamsErrorResponse" });
