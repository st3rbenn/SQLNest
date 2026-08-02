#!/usr/bin/env node
/**
 * Seed one-shot d'un canvas depuis un dump localStorage (Chrome DevTools).
 *
 * Contexte : le hook `useCanvasSync` (Phase 2 Bloc 4) push automatiquement
 * localStorage → serveur au premier drag une fois le user loggé. Ce script
 * couvre le cas où l'utilisateur veut **pré-enregistrer** son canvas AVANT
 * d'avoir un compte auth (typiquement : préserver un travail déjà fait
 * dans le localStorage sans passer par le flow signup + drag manuel).
 *
 * Stratégie :
 *   1. Insère un user "seed" avec un id texte prévisible (pas de collision
 *      avec les IDs générés par Better Auth qui sont des nanoid opaques).
 *   2. UPSERT canvas_state (user_id, schema_signature) → payload.
 *   3. Idempotent : ré-exécution safe (ON CONFLICT DO UPDATE partout).
 *
 * Rattachement futur : quand le user créera son vrai compte via /signup,
 * il faudra UPDATE canvas_state.user_id vers son nouveau user.id. Snippet
 * fourni en fin de script (commenté).
 *
 * Usage :
 *   node --env-file=.env infra/scripts/seed-canvas-from-localstorage.mjs
 *
 * Prérequis :
 *   - postgres-app container up (pnpm db:up).
 *   - Migrations 0000+0001+0002 appliquées (pnpm app:db:migrate).
 *   - .env racine avec DATABASE_URL renseigné.
 *
 * NOTE : on utilise le flag natif `--env-file` de Node 20.6+ pour charger
 * le .env sans dépendance runtime (dotenv est devDep de @sqlnest/db mais
 * n'est pas hoist par pnpm strict à la racine). Alternative si le flag
 * n'est pas dispo : `pnpm --filter @sqlnest/db exec node ../../infra/...`.
 */

// On utilise `pg` (déjà en devDep de la racine, hoist correctement) au lieu
// de `postgres.js` qui vit dans packages/db et n'est pas résolvable depuis
// la racine avec pnpm strict.
import pg from "pg";
const { Client } = pg;

if (process.env.DATABASE_URL === undefined) {
	console.error(`DATABASE_URL manquant après lecture de ${rootEnv}.`);
	process.exit(1);
}

// ─── Config seed ─────────────────────────────────────────────────────────
// User seed : email dans un TLD réservé RFC 6761 (`.local`) pour ne JAMAIS
// entrer en collision avec un vrai email lors d'un futur signup Better Auth.
const SEED_USER = {
	id: "manual-seed-canvas-preseed",
	email: "seed-canvas@sqlnest.local",
	name: "Canvas Seed",
	emailVerified: false
};

// Signature du canvas Apollon (30 tables). Format : engine:sortedNames.
// Alignée avec le format frontend (packages/db commentaire schema.ts).
const APOLLON_SIGNATURE =
	"postgres:_prisma_migrations,agency,cabinet,cabinet_reinforcement,company_group,custom_disaster_family_nature,custom_service_activity,cv_theque,degree,disaster_family,disaster_nature,disaster_nature_and_family_link,disponibility,disponibility_time_slot,intervention,media_case,resource,resource_intervention_link,resource_pair,resource_service_link,resource_software_link,scope,scope_resource_link,service,service_activity,service_service_activity_link,software,technical_acknowledgment,ue_region,unavailability";

// Payload agrégé : positions, sizes, widths (slice legacy), frames,
// edgeAnchors, hidden. Format opaque côté backend (jsonb) — le frontend
// deserialize dans les 4-5 hooks localStorage.
const APOLLON_PAYLOAD = {
	positions: {
		service: { x: 515.7865148862593, y: 1593.0564997315971 },
		service_service_activity_link: {
			x: 217.59314735198058,
			y: 1586.9195345161054
		},
		custom_disaster_family_nature: {
			x: 1294.4390489890868,
			y: 80.4987512500544
		},
		disaster_nature_and_family_link: {
			x: 1810.5403899234907,
			y: -115.39079314648706
		},
		_prisma_migrations: {
			x: 238.50319453786977,
			y: -234.10791893309639
		},
		resource_intervention_link: {
			x: 1859.0868216298006,
			y: 71.03451040443699
		},
		cabinet_reinforcement: { x: 1688.345013807534, y: 799.8018628295597 },
		disaster_family: { x: 2343.7686478574196, y: -120.46395933849487 },
		disaster_nature: { x: 1351.194638508269, y: -103.91533308353729 },
		intervention: { x: 2345.873552986448, y: 66.7175390399452 },
		media_case: { x: 218.51655280941935, y: 139.66040811429858 },
		degree: { x: -99.6502688128744, y: 465.1561705406476 },
		technical_acknowledgment: {
			x: -86.92299608560171,
			y: 215.5198069042839
		},
		cv_theque: { x: 216.64709234435477, y: 351.6300862500748 },
		resource: { x: 923.1846300948971, y: 412.5214649921061 },
		agency: { x: 2037.6807371573243, y: 751.1029345683704 },
		cabinet: { x: 2359.3795676101563, y: 915.5134453975608 },
		ue_region: { x: 2377.7904632566297, y: 750.4461172416658 },
		resource_pair: { x: 923.4088374697578, y: -124.96875307502089 },
		disponibility: { x: 213.11549027418977, y: 810.7888891862007 },
		disponibility_time_slot: {
			x: 185.9909901649402,
			y: 1021.0079565675298
		},
		unavailability: { x: -120.8572706096254, y: 788.5421978714027 },
		resource_software_link: {
			x: 923.3075458107076,
			y: 1284.8821162136758
		},
		software: { x: 922.7521296516047, y: 1474.350650495404 },
		scope_resource_link: { x: 1326.3520040041776, y: 1226.3910754898639 },
		company_group: { x: 1609.320784982544, y: 1445.0145122239478 },
		scope: { x: 1328.9654217184675, y: 1403.2028454329047 },
		custom_service_activity: {
			x: -8.471996656534373,
			y: 1376.5745525127134
		},
		service_activity: { x: -128.10298937986724, y: 1603.4125323284172 },
		resource_service_link: { x: 468.7168778266628, y: 1386.453775819978 }
	},
	sizes: {
		disaster_nature_and_family_link: { width: 335, height: 122 },
		disponibility_time_slot: { width: 282, height: 194 },
		custom_disaster_family_nature: { width: 355, height: 134 },
		_prisma_migrations: { width: 277, height: 223 },
		cv_theque: { width: 240, height: 256 },
		custom_service_activity: { width: 281, height: 132 }
	},
	widths: {
		disaster_nature_and_family_link: 330
	},
	frames: [
		{
			key: "f-1785538385700",
			label: "AGENCY",
			hue: 210,
			collections: ["agency", "cabinet", "ue_region", "cabinet_reinforcement"],
			rect: {
				x: 1574.0937531873944,
				y: 650.2326082928488,
				width: 1100,
				height: 483
			}
		},
		{
			key: "f-1785543880017",
			label: "Agenda",
			hue: 30,
			collections: ["disponibility", "disponibility_time_slot", "unavailability"],
			rect: {
				x: -142.3781173379474,
				y: 759.0754153772674,
				width: 668,
				height: 476
			}
		},
		{
			key: "f-1785543899725",
			label: "Common resource details",
			hue: 262,
			collections: ["degree", "media_case", "technical_acknowledgment", "cv_theque"],
			rect: {
				x: -144.22023700666682,
				y: 124.06180320351856,
				width: 665,
				height: 590
			}
		},
		{
			key: "f-1785543956391",
			label: "Disaster interventio -> Family loop",
			hue: 340,
			collections: [
				"resource_intervention_link",
				"disaster_nature_and_family_link",
				"disaster_nature",
				"custom_disaster_family_nature",
				"intervention",
				"disaster_family"
			],
			rect: {
				x: 1240.348592039463,
				y: -146.78283871931563,
				width: 1397,
				height: 420
			}
		},
		{
			key: "f-1785544054089",
			label: "Software",
			hue: 275,
			collections: ["resource_software_link", "software"],
			rect: {
				x: 880.5050803363624,
				y: 1247.142532611455,
				width: 324,
				height: 348
			}
		},
		{
			key: "f-1785544068812",
			label: "Scopes",
			hue: 155,
			collections: ["company_group", "scope", "scope_resource_link"],
			rect: {
				x: 1284.8411294344237,
				y: 1163.5583910189966,
				width: 621,
				height: 471
			}
		},
		{
			key: "f-1785544124956",
			label: "Service -> custom loop",
			hue: 210,
			collections: [
				"custom_service_activity",
				"service_activity",
				"service_service_activity_link",
				"service",
				"resource_service_link"
			],
			rect: {
				x: -204.27142401379746,
				y: 1305.1343565147097,
				width: 1012.7995389444754,
				height: 444.48248176551374
			}
		},
		{
			key: "f-1785544309069",
			label: "Resource",
			hue: 30,
			collections: ["resource"],
			rect: {
				x: 861.3029692073919,
				y: 336.7112425403526,
				width: 360,
				height: 491
			}
		}
	],
	edgeAnchors: {
		"e9-service_service_activity_link-service": { source: "right" },
		"e18-custom_disaster_family_nature-resource_intervention_link": {
			source: "right",
			target: "left"
		},
		"e19-cabinet_reinforcement-resource": { target: "right" },
		"e5-resource-agency": { target: "top", source: "right" },
		"e1-disaster_nature_and_family_link-disaster_family": { target: "left" },
		"e16-resource_pair-resource": { target: "top" },
		"e15-resource_pair-resource": { target: "top" },
		"e17-resource_intervention_link-resource": {
			target: "right",
			source: "bottom"
		},
		"e14-resource_software_link-resource": { target: "bottom" },
		"e30-resource_software_link-software": {
			source: "bottom",
			target: "top"
		},
		"e11-custom_service_activity-service_activity": {
			source: "left",
			target: "left"
		},
		"e25-disponibility_time_slot-disponibility": { target: "bottom" },
		"e2-intervention-disaster_family": { target: "bottom", source: "top" },
		"e6-custom_disaster_family_nature-disaster_nature": { source: "top" },
		"e31-resource_intervention_link-intervention": { target: "left" },
		"e13-resource_service_link-resource": { source: "top" },
		"e28-scope_resource_link-scope": { source: "bottom" }
	},
	hidden: []
};

// ─── Exécution ───────────────────────────────────────────────────────────
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
	// 1) User seed — ON CONFLICT sur id (idempotent).
	await client.query(
		`INSERT INTO "user" (id, email, email_verified, name)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (id) DO NOTHING`,
		[SEED_USER.id, SEED_USER.email, SEED_USER.emailVerified, SEED_USER.name]
	);
	console.log(`✓ user seed prêt (id=${SEED_USER.id}, email=${SEED_USER.email})`);

	// 2) Canvas state — UPSERT sur (user_id, schema_signature).
	const res = await client.query(
		`INSERT INTO canvas_state (user_id, schema_signature, payload)
		 VALUES ($1, $2, $3::jsonb)
		 ON CONFLICT (user_id, schema_signature) DO UPDATE
		   SET payload = EXCLUDED.payload,
		       updated_at = NOW()
		 RETURNING id, updated_at`,
		[SEED_USER.id, APOLLON_SIGNATURE, JSON.stringify(APOLLON_PAYLOAD)]
	);
	const row = res.rows[0];
	console.log(
		`✓ canvas_state upsert (id=${row.id}, updated_at=${row.updated_at.toISOString()})`
	);
	console.log(
		`  → ${Object.keys(APOLLON_PAYLOAD.positions).length} positions, ${APOLLON_PAYLOAD.frames.length} frames, ${Object.keys(APOLLON_PAYLOAD.edgeAnchors).length} edge anchors`
	);
} catch (err) {
	console.error("✗ seed échoué :", err);
	process.exitCode = 1;
} finally {
	await client.end();
}

// ─── Migration post-signup (à jouer plus tard, manuellement) ─────────────
// Quand tu créeras ton vrai compte via /signup, note ton user.id réel
// (visible via `SELECT id FROM "user" WHERE email = 'ton@email'`) et
// rattache le canvas seedé :
//
//   UPDATE canvas_state
//   SET user_id = '<ton-vrai-user-id>'
//   WHERE user_id = 'manual-seed-canvas-preseed';
//
//   DELETE FROM "user" WHERE id = 'manual-seed-canvas-preseed';
//
// Ou plus simple : garder le user seed et re-jouer ce script après avoir
// changé SEED_USER.id vers ton vrai id.
