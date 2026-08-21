/**
 * transactionWrap — helpers pour l'exec `⌘⇧⏎` en transaction ([[ADR-023]]
 * E/5). Deux préoccupations distinctes :
 *
 * 1. **Capability check** — le shortcut ne s'exécute QUE si l'engine
 *    supporte les transactions. Sur les engines non-relationnels (KV) ou
 *    Mongo standalone, le wrap échouerait au CLI. Le check préemptif évite
 *    une erreur cryptique + protège le pattern feedback-no-silent-ignore-auth
 *    (jamais no-op silencieux, toast danger explicite si false).
 *
 * 2. **Double-wrap detection (D7)** — si l'user a DÉJÀ tapé `transaction
 *    { … }` racine et hit `⌘⇧⏎`, on ne re-wrappe PAS (produirait
 *    `transaction { transaction { … } }` REFUSÉ au parse). On respecte
 *    l'intention utilisateur : exec direct sans modification.
 *
 * ─── Limites v1 ─────────────────────────────────────────────────────
 * `supportsTransactionsForEngine` s'appuie sur la capabilité statique
 * déclarée par SNQL (`POSTGRES_CAPABILITIES` / `MONGODB_CAPABILITIES` etc.).
 * Mongo standalone (non-replica-set) est déclaré `transaction`-capable
 * mais échoue runtime — le fix propre exige `ConnectionCapabilities`
 * runtime enrichi via `engineMetadata` au handshake tunnel ([[ADR-023]]
 * Risque 2). Reporté E/8 ou ticket futur.
 */

import { capabilitiesFor, type Statement } from "@sqlnest/snql";

/** True si l'engine SNQL déclare supporter le verbe `transaction`. Faux
 * pour KV, engines inconnus. Voir limites v1 ci-dessus pour Mongo. */
export function supportsTransactionsForEngine(engine: string): boolean {
	const caps = capabilitiesFor(engine);
	if (caps === undefined) return false;
	return caps.supports.has("transaction");
}

/** Résultat du wrap. `kind` route l'UX :
 *  - `wrap` : source modifiée = `transaction { <src trim> }` — envoyée au CLI.
 *  - `already_tx` : source inchangée — l'user avait tapé une tx explicite,
 *    on respecte (D7 no-op).
 */
export type TxWrapResult =
	| { readonly kind: "wrap"; readonly source: string }
	| { readonly kind: "already_tx"; readonly source: string };

/** Enveloppe la source dans un bloc transaction sauf si elle EN EST DÉJÀ
 * une racine (D7). Le trim évite d'insérer un tx `transaction {  <src>  }`
 * avec espaces parasites en début/fin (parser tolérant mais on préfère
 * une source lisible dans les logs backend + history). */
export function wrapInTransaction(
	source: string,
	statement: Statement
): TxWrapResult {
	if (statement.operation === "transaction") {
		return { kind: "already_tx", source };
	}
	const trimmed = source.trim();
	return { kind: "wrap", source: `transaction { ${trimmed} }` };
}
