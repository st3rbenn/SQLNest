import { EngineConfigError } from "../errors";

/**
 * Config de connexion MongoDB **résolue**. `url` porte l'URI complète (avec
 * credentials) — secret : passer par {@link describeMongoConfig} pour l'affichage.
 */
export interface MongoConnectionConfig {
	readonly engine: "mongodb";
	readonly url: string;
	readonly database: string;
	/** Nombre de documents échantillonnés par collection à l'introspection. */
	readonly sampleSize: number;
}

export interface MongoConfigInput {
	readonly url: string;
	/** Base cible ; à défaut, déduite du chemin de l'URL. */
	readonly database?: string;
	readonly sampleSize?: number;
}

const DEFAULT_SAMPLE_SIZE = 100;
const SCHEMES = ["mongodb://", "mongodb+srv://"];

function hasMongoScheme(url: string): boolean {
	return SCHEMES.some((scheme) => url.startsWith(scheme));
}

/**
 * Extrait le nom de base d'une URI Mongo par parsing **string** (pas `new URL`,
 * qui rejette les URI multi-hôtes de replica set `host1,host2/db`). Le driver
 * reste l'autorité de validation ; ici on ne fait que localiser le segment base.
 */
function extractDatabase(url: string): string {
	const schemeEnd = url.indexOf("://");
	let rest = schemeEnd >= 0 ? url.slice(schemeEnd + 3) : url;
	// Saute les credentials (le dernier '@' sépare userinfo des hôtes).
	const at = rest.lastIndexOf("@");
	if (at >= 0) {
		rest = rest.slice(at + 1);
	}
	// Coupe la query (options).
	const query = rest.indexOf("?");
	if (query >= 0) {
		rest = rest.slice(0, query);
	}
	// Le segment base suit la liste d'hôtes.
	const slash = rest.indexOf("/");
	if (slash < 0) {
		return "";
	}
	return decodeURIComponent(rest.slice(slash + 1));
}

/** Normalise une entrée en {@link MongoConnectionConfig}. Lève {@link EngineConfigError}. */
export function resolveMongoConfig(
	input: MongoConfigInput
): MongoConnectionConfig {
	if (!hasMongoScheme(input.url)) {
		throw new EngineConfigError(
			"URL MongoDB attendue (schéma 'mongodb://' ou 'mongodb+srv://')"
		);
	}

	const database = input.database ?? extractDatabase(input.url);
	if (database === "") {
		throw new EngineConfigError(
			"Base MongoDB non spécifiée (ni dans l'URL ni via `database`)"
		);
	}

	const sampleSize = input.sampleSize ?? DEFAULT_SAMPLE_SIZE;
	if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
		throw new EngineConfigError("`sampleSize` doit être un entier positif");
	}

	return { engine: "mongodb", url: input.url, database, sampleSize };
}

/**
 * Représentation **sans secret** d'une URI Mongo, pour logs/UI. Redaction par
 * string (robuste multi-hôtes) : userinfo → `***`, et la query est **retirée**
 * (elle peut porter des secrets : `tlsCertificateKeyFilePassword`, tokens AWS…).
 */
export function describeMongoConfig(config: MongoConnectionConfig): string {
	let url = config.url;
	const query = url.indexOf("?");
	if (query >= 0) {
		url = url.slice(0, query);
	}
	const schemeEnd = url.indexOf("://");
	const at = url.indexOf("@");
	if (schemeEnd >= 0 && at > schemeEnd) {
		url = `${url.slice(0, schemeEnd + 3)}***@${url.slice(at + 1)}`;
	}
	return url;
}
