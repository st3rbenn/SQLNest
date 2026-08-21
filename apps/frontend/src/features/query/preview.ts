/**
 * preview — fetch un aperçu "N lignes seraient affectées" avant confirmation
 * d'un write non filtré ([[ADR-023]] E/4). Réutilise `runQueryRequest` avec
 * une source rewrite `pick count` — envoyée sur la MÊME route `/query` que
 * les runs normaux, avec le même body {source} — ZÉRO backend delta
 * ([[ADR-012]] préservé strictement).
 *
 * ─── Contrat ─────────────────────────────────────────────────────────
 * - Timeout 3s hard : sur grosses tables sans index sur predicate, le
 *   count peut être coûteux ; on préfère afficher "aperçu indisponible
 *   (timeout)" plutôt que faire attendre l'user, cf. [[ADR-023]] Risque 4.
 * - Rewrite unavailable (raw / upsert / transaction / let) → return
 *   `{status:'unavailable', reason}` sans roundtrip.
 * - Erreur d'exec (parser, moteur, driver) → return `{status:'unavailable',
 *   reason}` — on n'échoue jamais le pending state à cause d'un preview KO.
 */

import type { Statement } from "@sqlnest/snql";
import { buildPreviewCountSource } from "./previewCountRewrite";
import { runQueryRequest } from "./useRunQuery";

/** Résultat du fetch preview — état + payload optionnel. Le caller
 * (WriteConfirmBar) route sur `status` pour choisir l'affichage. */
export type PreviewResult =
	| {
			readonly status: "ok";
			readonly estimatedRowCount: number;
			readonly disclaimer?: string;
	  }
	| {
			readonly status: "unavailable";
			readonly reason:
				| "unsupported" // raw / upsert / transaction / let
				| "timeout" // > 3s roundtrip
				| "run_error" // le run count a échoué
				| "parse_error"; // le rewrite est invalide (bug côté frontend — ne devrait pas arriver)
	  };

/** Cap dur pour l'aperçu — sur une table 100M sans index le count peut
 * prendre 30s, l'user hit ⌘⏎ et attend un rendu instantané. On préfère
 * "indisponible" à "attente longue". Voir [[ADR-023]] Risque 4. */
const PREVIEW_TIMEOUT_MS = 3000;

export interface PreviewInput {
	readonly originalSource: string;
	readonly statement: Statement;
	readonly connectionId: string;
	readonly teamSlug: string;
}

/**
 * Fetch l'aperçu ou explique pourquoi indisponible. Ne throw jamais — les
 * erreurs sont capturées et remontées en `status: 'unavailable'`.
 */
export async function fetchPreviewCount(
	input: PreviewInput
): Promise<PreviewResult> {
	const rewrite = buildPreviewCountSource(input.originalSource, input.statement);
	if (rewrite === null) {
		return { status: "unavailable", reason: "unsupported" };
	}

	// Timeout 3s via Promise.race — le run continue en background si dépassé
	// (pas d'AbortController exposé par runQueryRequest ici), mais son
	// résultat est ignoré. Acceptable en v1 : le count preview n'a pas de
	// side-effect (SELECT), aucun risque de wipe.
	const timeoutPromise = new Promise<PreviewResult>((resolve) => {
		setTimeout(
			() => resolve({ status: "unavailable", reason: "timeout" }),
			PREVIEW_TIMEOUT_MS
		);
	});

	const runPromise = runQueryRequest({
		connectionId: input.connectionId,
		source: rewrite.source,
		teamSlug: input.teamSlug
	})
		.then((data): PreviewResult => {
			// Le rewrite produit `pick count(*) as _preview_count` — le driver
			// renvoie une seule row avec un seul field. On extrait la 1re
			// column pour tolérer un renommage éventuel (majuscule, quoting).
			const row = data.rows[0] as Record<string, unknown> | undefined;
			const col = data.columns[0]?.name;
			const raw = row && col ? row[col] : undefined;
			// Le count peut arriver en number ou en string (pg driver renvoie
			// bigint stringifié pour les grandes valeurs). Cast tolérant.
			const n = typeof raw === "number" ? raw : Number(raw);
			if (!Number.isFinite(n)) {
				return { status: "unavailable", reason: "parse_error" };
			}
			return {
				status: "ok",
				estimatedRowCount: n,
				disclaimer: rewrite.note
			};
		})
		.catch((): PreviewResult => ({ status: "unavailable", reason: "run_error" }));

	return Promise.race([runPromise, timeoutPromise]);
}
