import { plannerError } from "@sqlnest/snql";
import type { Db } from "mongodb";
import { EngineConnectionError } from "../errors";

/**
 * Features driver Mongo détectées au bootstrap (probe `hello()` +
 * `serverStatus()` + `buildInfo()`) et cachées sur la Connection. Chaque
 * feature correspond à une capacité driver qui varie par version×topologie ;
 * les asserts codegen lisent ce bag avant de codegen.
 *
 * Matrice version × feature :
 *
 * | Feature               | Version min | Topologie          | Utilisé par            |
 * |-----------------------|-------------|--------------------|------------------------|
 * | pipelineUpdate        | 4.2+        | any                | write-join, cast in where write |
 * | mergeStandalone       | 4.2+        | any                | insert-select `$merge` (hors tx) |
 * | mergeInTx             | 5.0+        | replica set        | insert-select en session tx |
 * | exprConvert           | 4.0+        | any                | cast in predicate |
 * | replicaSet            | any         | replica set        | tx obligatoire, savepoint refus |
 * | serverVersion         | any         | any                | trace, telemetry, refus détaillé |
 * | topology              | any         | any                | 'standalone' | 'replicaSet' | 'sharded' | 'unknown' |
 */
export interface MongoFeatures {
	readonly serverVersion: string;
	readonly topology: MongoTopology;
	readonly pipelineUpdate: boolean;
	readonly mergeStandalone: boolean;
	readonly mergeInTx: boolean;
	readonly exprConvert: boolean;
	readonly replicaSet: boolean;
}

export type MongoTopology = "standalone" | "replicaSet" | "sharded" | "unknown";

/**
 * Bag exposé sur `Connection.engineFeatures` (adapter.ts) — pattern typé
 * pour découpler la Connection générique des types moteur. Autres adapters
 * peuvent ajouter leur propre variante (PostgresFeatures, etc.).
 */
export interface MongoEngineFeatures {
	readonly kind: "mongodb";
	readonly features: MongoFeatures;
}

/**
 * Résolution pure : à partir des outputs `hello()`, `serverStatus()` et
 * `buildInfo()`, calcule le MongoFeatures cross-topologie. Extraite du
 * probe I/O pour être testable sans driver Mongo.
 */
export function resolveMongoFeatures(inputs: {
	readonly buildInfo: { readonly version?: unknown };
	readonly hello: { readonly setName?: unknown; readonly msg?: unknown };
	readonly serverStatus?: { readonly process?: unknown };
}): MongoFeatures {
	const version =
		typeof inputs.buildInfo.version === "string" &&
		inputs.buildInfo.version.length > 0
			? inputs.buildInfo.version
			: "unknown";
	const replicaSet =
		typeof inputs.hello.setName === "string" && inputs.hello.setName.length > 0;
	const sharded = inputs.hello.msg === "isdbgrid";
	const topology: MongoTopology = sharded
		? "sharded"
		: replicaSet
			? "replicaSet"
			: version !== "unknown"
				? "standalone"
				: "unknown";

	const versionMinor = parseMongoMinor(version);
	const at42 =
		versionMinor.major > 4 ||
		(versionMinor.major === 4 && versionMinor.minor >= 2);
	const at50 = versionMinor.major >= 5;
	const at40 =
		versionMinor.major > 4 ||
		(versionMinor.major === 4 && versionMinor.minor >= 0);

	return {
		serverVersion: version,
		topology,
		pipelineUpdate: at42,
		mergeStandalone: at42,
		// $merge dans une session tx exige Mongo 5.0+ ET replica set (jamais
		// standalone). Conservateur : sharded compte aussi (tx multi-doc OK).
		mergeInTx: at50 && (replicaSet || sharded),
		exprConvert: at40,
		replicaSet
	};
}

function parseMongoMinor(version: string): { major: number; minor: number } {
	if (version === "unknown") return { major: 0, minor: 0 };
	const parts = version.split(".");
	const major = Number.parseInt(parts[0] ?? "0", 10);
	const minor = Number.parseInt(parts[1] ?? "0", 10);
	return {
		major: Number.isFinite(major) ? major : 0,
		minor: Number.isFinite(minor) ? minor : 0
	};
}

/**
 * Probe une connexion Mongo ouverte. Utilise `db.admin()` pour cibler la base
 * admin (les commandes `hello`, `buildInfo`, `serverStatus` y vivent). Les
 * échecs sont enveloppés en `EngineConnectionError` — un probe raté = adapter
 * non fonctionnel, on refuse la connexion plutôt que de fabriquer un
 * MongoFeatures fictif qui contaminerait les asserts sprint.
 */
export async function probeMongoFeatures(db: Db): Promise<MongoFeatures> {
	try {
		const admin = db.admin();
		const [buildInfo, hello] = await Promise.all([
			admin.buildInfo(),
			admin.command({ hello: 1 })
		]);
		let serverStatus: { readonly process?: unknown } | undefined;
		try {
			serverStatus = (await admin.serverStatus()) as {
				readonly process?: unknown;
			};
		} catch {
			// serverStatus() demande le privilège `serverStatus` — pas garanti
			// sur toutes les configs (Atlas users limités). On tombe en mode
			// dégradé : la version + hello suffisent pour la matrice actuelle.
		}
		const inputs =
			serverStatus === undefined
				? {
						buildInfo: buildInfo as { readonly version?: unknown },
						hello: hello as {
							readonly setName?: unknown;
							readonly msg?: unknown;
						}
					}
				: {
						buildInfo: buildInfo as { readonly version?: unknown },
						hello: hello as {
							readonly setName?: unknown;
							readonly msg?: unknown;
						},
						serverStatus
					};
		return resolveMongoFeatures(inputs);
	} catch (cause) {
		throw new EngineConnectionError(
			"Probe capabilities MongoDB échoué — vérifie que l'user a le rôle 'clusterMonitor' (ou 'read' sur 'admin') pour lire buildInfo/hello.",
			{ cause }
		);
	}
}

/**
 * Assert helper — lève `planner_mongo_version_capability_missing` avec un
 * message détaillé si la feature demandée n'est pas disponible. Appelé par
 * run.ts / adapter.ts avant de codegen une op qui exige la feature (pas par
 * le planner pur, qui n'a pas accès au Connection).
 *
 * Format du code : `planner_mongo_version_capability_missing`. Le nom de
 * feature apparaît dans le message pour diagnostic ; le code reste générique
 * pour éviter d'exploser le registre.
 */
export function assertMongoFeature(
	features: MongoFeatures,
	feature: keyof MongoFeatures
): void {
	if (features[feature] === true) return;
	if (typeof features[feature] === "string") return;
	throw plannerError(
		"planner_mongo_version_capability_missing",
		`Feature '${feature}' non supportée par MongoDB ${features.serverVersion} (${features.topology}). Voir capability-probe.ts pour la matrice version × feature. Contournement : upgrade Mongo ou refactor la requête pour éviter cette feature.`
	);
}
