import { describe, expect, it } from "vitest";
import type { Collection, SchemaModel } from "../schema-model";
import { detectRelationCandidates, shouldOfferInference } from "./candidates";

/** Fabrique une collection à partir de noms de colonnes (types indifférents ici). */
function coll(
	name: string,
	columns: readonly string[],
	primaryKey?: readonly string[]
): Collection {
	return {
		name,
		source: "declared",
		...(primaryKey !== undefined ? { primaryKey } : {}),
		fields: columns.map((c) => ({
			name: c,
			type: "int" as const,
			nullable: true,
			source: "declared" as const
		}))
	};
}

function schema(collections: readonly Collection[]): SchemaModel {
	return { engine: "mssql", collections, relations: [] };
}

describe("detectRelationCandidates — ancrage PK", () => {
	it("clé que chaque table possède en propre (`id` partout, `_id` sous Mongo) : pas un lien", () => {
		const collections = [
			coll("CLI_CLIENT", ["id", "CLI_CODE"], ["id"]),
			coll("CMD_COMMANDE", ["id", "CLI_CODE"], ["id"]),
			coll("FAC_FACTURE", ["id", "CLI_CODE"], ["id"])
		];
		const ids = detectRelationCandidates(schema(collections)).map((c) => c.columns);
		expect(ids).not.toContainEqual(["id"]);
		expect(ids).toContainEqual(["CLI_CODE"]);
	});

	it("PK composite répétée dans plusieurs tables → 1 candidat, référence = propriétaire de la PK", () => {
		const triplet = ["dos_annee", "div_source", "dos_numero"];
		const collections = [
			coll("dos_dossier", [...triplet, "libelle"], triplet),
			coll("dos_facture", [...triplet, "montant"]),
			coll("dos_reglement", [...triplet, "date_paiement"])
		];
		const cands = detectRelationCandidates(schema(collections));
		expect(cands).toHaveLength(1);
		const c = cands[0]!;
		expect(c.anchor).toBe("primary-key");
		expect(c.columns).toEqual(triplet);
		expect(c.suggestedReference).toBe("dos_dossier");
		// 3 tables portent le triplet → 3 carriers, 2 edges à la confirmation.
		expect(c.carriers).toEqual(["dos_dossier", "dos_facture", "dos_reglement"]);
	});

	it("PK simple portée ailleurs → candidat colonne, référence = table PK", () => {
		const collections = [
			coll("annuaire", ["ann_code", "nom"], ["ann_code"]),
			coll("contrat", ["ann_code", "prime"]),
			coll("sinistre", ["ann_code", "montant"])
		];
		const cands = detectRelationCandidates(schema(collections));
		expect(cands).toHaveLength(1);
		expect(cands[0]).toMatchObject({
			anchor: "primary-key",
			columns: ["ann_code"],
			suggestedReference: "annuaire"
		});
	});

	it("PK non portée par une AUTRE table → aucun candidat (référence isolée)", () => {
		const collections = [
			coll("users", ["id", "email"], ["id"]),
			coll("orders", ["order_no", "total"], ["order_no"])
		];
		expect(detectRelationCandidates(schema(collections))).toEqual([]);
	});

	it("deux tables partageant la même PK → un seul candidat, les deux en options", () => {
		const collections = [
			coll("compte", ["cpt_id", "solde"], ["cpt_id"]),
			coll("compte_archive", ["cpt_id", "solde"], ["cpt_id"]),
			coll("ecriture", ["cpt_id", "libelle"])
		];
		const cands = detectRelationCandidates(schema(collections));
		expect(cands).toHaveLength(1);
		expect(cands[0]!.referenceOptions).toEqual(["compte", "compte_archive"]);
	});
});

describe("detectRelationCandidates — ancrage nom (sans PK)", () => {
	it("colonne pivot sans PK → référence devinée par le préfixe du nom", () => {
		const collections = [
			coll("ann_annuaire", ["ann_code_annuaire", "nom"]),
			coll("contrat", ["ann_code_annuaire", "prime"]),
			coll("sinistre", ["ann_code_annuaire", "montant"])
		];
		const cands = detectRelationCandidates(schema(collections));
		expect(cands).toHaveLength(1);
		expect(cands[0]).toMatchObject({
			anchor: "name",
			columns: ["ann_code_annuaire"],
			suggestedReference: "ann_annuaire"
		});
	});

	it("réf. par nom-racine : ANN_ANNUAIRE gagne sur ANN_EXCLU (pas le plus court)", () => {
		// `ann_exclu` est plus court et matche le préfixe, mais sa racine
		// « exclu » n'apparaît pas dans la colonne ; `ann_annuaire` a « annuaire »
		// ∈ `ann_code_annuaire` → c'est lui la vraie référence.
		const collections = [
			coll("ann_exclu", ["ann_code_annuaire", "x"]),
			coll("ann_annuaire", ["ann_code_annuaire", "nom"]),
			coll("contrat", ["ann_code_annuaire", "prime"]),
			coll("sinistre", ["ann_code_annuaire", "montant"])
		];
		const cands = detectRelationCandidates(schema(collections));
		const c = cands.find((x) => x.columns[0] === "ann_code_annuaire");
		expect(c?.suggestedReference).toBe("ann_annuaire");
	});

	it("table racine la plus courte gagne la suggestion", () => {
		const collections = [
			coll("ann_annuaire_historique", ["ann_code", "v"]),
			coll("ann_annuaire", ["ann_code", "nom"]),
			coll("x", ["ann_code", "y"])
		];
		const cands = detectRelationCandidates(schema(collections));
		expect(cands[0]!.suggestedReference).toBe("ann_annuaire");
		expect(cands[0]!.referenceOptions).toEqual([
			"ann_annuaire",
			"ann_annuaire_historique"
		]);
	});

	it("colonne partagée SANS table homonyme → écartée (bruit d'attribut commun)", () => {
		const collections = [
			coll("facture", ["libelle", "montant"]),
			coll("avoir", ["libelle", "montant"]),
			coll("devis", ["libelle", "total"])
		];
		// `libelle`/`montant` n'ont pas de table racine → aucun hub colonne
		// unique (passe 3 exige un vrai match de nom).
		const cands = detectRelationCandidates(schema(collections));
		expect(cands.every((c) => c.columns.length !== 1)).toBe(true);
	});
});

describe("detectRelationCandidates — composites par co-occurrence (sans PK ni nom)", () => {
	it("composite étendu au sur-ensemble : le triplet se recompose", () => {
		// La paire {dos_annee, dos_numero_dossier} co-apparaît dans 3 tables ;
		// div_source est dans ces 3 + 1 autre (sur-ensemble strict) → rejoint
		// la clé au lieu de la fragmenter.
		const collections = [
			coll("dos_dossier", ["dos_annee", "div_source", "dos_numero_dossier", "l"]),
			coll("dos_facture", ["dos_annee", "div_source", "dos_numero_dossier", "m"]),
			coll("dos_reglement", ["dos_annee", "div_source", "dos_numero_dossier", "d"]),
			coll("div_source", ["div_source", "code"])
		];
		const cands = detectRelationCandidates(schema(collections));
		const composite = cands.find((c) => c.columns.length >= 3);
		expect(composite).toBeDefined();
		expect(composite!.columns).toEqual([
			"div_source",
			"dos_annee",
			"dos_numero_dossier"
		]);
		// carriers = les 3 tables de la paire (là où les 3 colonnes co-existent).
		expect(composite!.carriers).toEqual([
			"dos_dossier",
			"dos_facture",
			"dos_reglement"
		]);
		expect(composite!.suggestedReference).toBe("dos_dossier");
	});

	it("colonnes co-apparaissant exactement ensemble → candidat composite", () => {
		const collections = [
			coll("t_ref", ["k_a", "k_b", "extra"]),
			coll("t1", ["k_a", "k_b", "c1"]),
			coll("t2", ["k_a", "k_b", "c2"])
		];
		const cands = detectRelationCandidates(schema(collections));
		const composite = cands.find((c) => c.columns.length === 2);
		expect(composite).toBeDefined();
		expect(composite!.columns).toEqual(["k_a", "k_b"]);
		expect(composite!.anchor).toBe("co-occurrence");
	});
});

describe("detectRelationCandidates — anti-bruit & tri", () => {
	it("colonne d'audit portée par >60% des tables → écartée des passes non-ancrées (grosse base)", () => {
		// 30 tables (≥ seuil audit) : `date_creation` dans 25 (83% > 60%) sans
		// PK → écartée ; `sml_id` dans 3 avec table racine → gardée.
		const collections: Collection[] = [];
		for (let i = 0; i < 25; i++) {
			collections.push(coll(`t${i}`, ["date_creation", `own${i}`]));
		}
		for (let i = 25; i < 30; i++) {
			collections.push(coll(`u${i}`, [`own${i}`]));
		}
		collections.push(coll("sml_ref", ["sml_id", "nom"]));
		collections.push(coll("contrat", ["sml_id"]));
		collections.push(coll("sinistre", ["sml_id"]));
		const cands = detectRelationCandidates(schema(collections));
		expect(cands.some((c) => c.columns.includes("date_creation"))).toBe(false);
		expect(cands.some((c) => c.suggestedReference === "sml_ref")).toBe(true);
	});

	it("une PK très répandue reste détectée (le filtre audit ne s'applique pas à la PK)", () => {
		const collections = [
			coll("hub", ["hub_id", "nom"], ["hub_id"]),
			coll("a", ["hub_id", "xa"]),
			coll("b", ["hub_id", "xb"]),
			coll("c", ["hub_id", "xc"]),
			coll("d", ["hub_id", "xd"])
		];
		// hub_id dans 5/5 tables = 100%, mais c'est une PK → gardé.
		const cands = detectRelationCandidates(schema(collections));
		expect(cands[0]).toMatchObject({
			anchor: "primary-key",
			suggestedReference: "hub"
		});
	});

	it("tri par impact décroissant puis fiabilité d'ancrage", () => {
		const collections = [
			// gros hub PK (4 carriers)
			coll("big", ["big_id", "n"], ["big_id"]),
			coll("b1", ["big_id"]),
			coll("b2", ["big_id"]),
			coll("b3", ["big_id"]),
			// petit hub nom (2 carriers)
			coll("sml_ref", ["sml_id", "n"]),
			coll("s1", ["sml_id"])
		];
		const cands = detectRelationCandidates(schema(collections));
		expect(cands[0]!.suggestedReference).toBe("big");
		expect(cands[0]!.carriers.length).toBeGreaterThan(
			cands[1]!.carriers.length
		);
	});

	it("colonne présente dans une seule table → aucun candidat", () => {
		const collections = [
			coll("solo", ["solo_only", "x"]),
			coll("autre", ["y"])
		];
		expect(detectRelationCandidates(schema(collections))).toEqual([]);
	});
});

describe("shouldOfferInference", () => {
	it("relations déjà présentes → pas d'offre", () => {
		const s: SchemaModel = {
			engine: "postgres",
			collections: [
				coll("a", ["a_id"], ["a_id"]),
				coll("b", ["a_id"])
			],
			relations: [
				{
					from: { collection: "b", fields: ["a_id"] },
					to: { collection: "a", fields: ["a_id"] },
					kind: "many-to-one",
					origin: "foreign-key",
					confidence: 1
				}
			]
		};
		expect(shouldOfferInference(s)).toBe(false);
	});

	it("aucune relation + candidats détectés → offre", () => {
		const s = schema([
			coll("annuaire", ["ann_code", "nom"], ["ann_code"]),
			coll("contrat", ["ann_code", "prime"])
		]);
		expect(shouldOfferInference(s)).toBe(true);
	});

	it("aucune relation mais aucun candidat → pas d'offre", () => {
		const s = schema([
			coll("a", ["x"]),
			coll("b", ["y"])
		]);
		expect(shouldOfferInference(s)).toBe(false);
	});
});
