/**
 * Relier un projet à une connexion (ADR-038 S5, ADR-037 D1) : la table
 * d'historique de la base doit être celle de l'ORM du projet, puis le bloc
 * `project` est enregistré. Partagé par `link-project`, `add-connection` et
 * `connect`.
 */

import type { OrmDetection } from "../../orm/detect";
import {
	checkHistory,
	describeHistory,
	describeNoHistory,
	keepsHistory,
	migrationsDir
} from "../../orm/history";
import { ORM_LABELS } from "../../orm/types";
import { parseConnectionString } from "../../services/connection-strings";
import type { ConnectionProbe } from "../../services/engine";
import {
	entryUrl,
	type LocalConnectionEntry,
	type LocalConnectionProject,
	loadLocalConnections,
	setConnectionProject
} from "../../services/local-connections";
import { tildify } from "../../ui/paths";
import type { Prompter } from "../../ui/prompts";
import { describeFailure } from "../add-connection/errors";

export class LinkProjectError extends Error {
	readonly kind:
		| "invalid-input"
		| "not-found"
		| "mismatch"
		| "unreachable"
		| "cancelled";
	constructor(kind: LinkProjectError["kind"], message: string) {
		super(message);
		this.name = "LinkProjectError";
		this.kind = kind;
	}
}

export interface LinkOptions {
	readonly name: string;
	readonly detection: OrmDetection;
	readonly apply: boolean;
	/** Tables de la base, déjà lues par le test d'`add-connection`. */
	readonly collectionNames?: readonly string[];
	/** Lecture des tables de la base ; absent avec `collectionNames`. */
	readonly probe?: (url: string) => Promise<ConnectionProbe>;
	readonly interactive: boolean;
	readonly prompter: Prompter;
	readonly stdout: (line: string) => void;
}

export async function linkConnection(
	opts: LinkOptions
): Promise<LocalConnectionProject> {
	const { name, detection } = opts;
	const entry = loadLocalConnections()?.connections.find(
		(c) => c.name === name
	);
	if (entry === undefined) {
		throw new LinkProjectError("not-found", `Aucune connexion « ${name} ».`);
	}
	const previous = entry.project;
	if (
		previous !== undefined &&
		previous.path !== detection.dir &&
		opts.interactive &&
		!(await opts.prompter.confirm(
			`« ${name} » est relié à ${tildify(previous.path)}. Remplacer ? [y/N] `
		))
	) {
		throw new LinkProjectError("cancelled", "Annulé — liaison inchangée");
	}

	let tables = opts.collectionNames;
	if (tables === undefined && opts.probe !== undefined) {
		try {
			tables = (await opts.probe(entryUrl(entry))).collectionNames;
		} catch (err) {
			const reason = describeFailure(err);
			if (!opts.interactive) {
				throw new LinkProjectError(
					"unreachable",
					`Base injoignable : ${reason} — impossible de vérifier sa table d'historique.`
				);
			}
			opts.stdout(`✗ Base injoignable : ${reason}`);
			if (!(await opts.prompter.confirm("Relier sans vérifier ? [y/N] "))) {
				throw new LinkProjectError("cancelled", "Annulé — rien n'a été relié");
			}
		}
	}
	const engine = engineOf(entry);
	const history = engine === undefined || keepsHistory(detection.orm, engine);
	if (!history) {
		opts.stdout(`✓ ${describeNoHistory(detection.orm, engine as string)}`);
	} else if (tables !== undefined) {
		const check = checkHistory(detection.orm, tables);
		const verdict = describeHistory(detection.orm, check);
		if (check.other !== undefined) {
			throw new LinkProjectError("mismatch", verdict);
		}
		opts.stdout(check.present ? `✓ ${verdict}` : verdict);
	}

	if (history) {
		const migrations = migrationsDir(detection);
		opts.stdout(
			migrations !== undefined
				? `  migrations : ${tildify(migrations)}`
				: "  pas encore de dossier de migrations"
		);
	}
	const project: LocalConnectionProject = {
		path: detection.dir,
		orm: detection.orm,
		apply: opts.apply
	};
	setConnectionProject(name, project);
	opts.stdout(
		`✓ « ${name} » relié à ${tildify(detection.dir)} (${ORM_LABELS[detection.orm]}${
			opts.apply ? "" : ", migrations écrites sans toucher la base"
		})`
	);
	return project;
}

/** Moteur de la connexion, lu dans son URL ; inconnu si elle est illisible. */
function engineOf(entry: LocalConnectionEntry): string | undefined {
	try {
		return parseConnectionString(entryUrl(entry))?.engine;
	} catch {
		return undefined;
	}
}
