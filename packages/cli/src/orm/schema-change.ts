/**
 * Boucle d'un changement de schéma dans le projet relié (ADR-037 D3, D4, D5,
 * D7) : DDL compilé avec le profil de l'ORM sur une introspection fraîche,
 * migration écrite, modèle patché et validé avant la base, migration
 * appliquée, puis contrôles. Sans historique de migrations (Prisma sous
 * MongoDB, D3 bis), pas de fichier : SQLNest applique le DDL lui-même. Un
 * échec avant la base, ou de l'application, remet les fichiers et la base en
 * l'état ; un écart après application est rapporté.
 */

import { type Connection, dropFailedIndex } from "@sqlnest/engine";
import {
	applyDdlToSchema,
	compareSchemas,
	ddlScope,
	getMapper,
	lowerDDL,
	type MapperContext,
	parse,
	type SchemaDiff,
	type SupportedEngine,
	tokenize
} from "@sqlnest/snql";
import type {
	TunnelSchemaChangeData,
	TunnelSchemaChangeNames,
	TunnelSchemaCheck,
	TunnelSchemaPreviewData
} from "@sqlnest/tunnel-protocol";
import type { LocalConnectionProject } from "../services/local-connections";
import {
	type OrmAdapter,
	type SchemaChange,
	SchemaChangeError,
	type Written,
	type WrittenMigration
} from "./adapter";
import { migrationSql } from "./migration-sql";
import { prismaAdapter } from "./prisma/adapter";
import { ORM_LABELS, type OrmName } from "./types";

const ADAPTERS: Partial<Record<OrmName, OrmAdapter>> = {
	prisma: prismaAdapter
};

export interface SchemaChangeInput {
	readonly project: LocalConnectionProject;
	readonly src: string;
	readonly names?: TunnelSchemaChangeNames;
	readonly databaseUrl: string;
	readonly connection: Connection;
	readonly env: NodeJS.ProcessEnv;
}

/** Le changement compilé avec le profil de l'ORM, sur une introspection fraîche. */
async function prepare(
	input: SchemaChangeInput,
	adapters: Partial<Record<OrmName, OrmAdapter>>
): Promise<{ readonly adapter: OrmAdapter; readonly change: SchemaChange }> {
	const { project, connection } = input;
	const adapter = adapters[project.orm];
	if (adapter === undefined) {
		throw new SchemaChangeError(
			`SQLNest n'écrit pas encore les migrations ${ORM_LABELS[project.orm]}`
		);
	}
	const statement = parse(tokenize(input.src));
	if (statement.operation !== "ddl") {
		throw new SchemaChangeError(
			"Un changement de schéma attend une instruction DDL (create table, add column, …)"
		);
	}
	const before = await connection.introspect();
	const plan = lowerDDL(
		statement as Parameters<typeof lowerDDL>[0],
		before,
		adapter.ddlOptions(connection.engine)
	);
	const native = getMapper(connection.engine as SupportedEngine).mapDDL?.(
		plan,
		mapperContext(connection)
	);
	if (native === undefined) {
		throw new SchemaChangeError(
			`Pas de DDL ${connection.engine} pour ce changement`
		);
	}
	return {
		adapter,
		change: {
			...input,
			plan,
			native,
			...(adapter.migrations(connection.engine)
				? { sql: migrationSql(native, input.src) }
				: {}),
			before
		}
	};
}

/**
 * Aperçu (ADR-039 D3) : les noms que le changement donnerait dans le modèle
 * du projet. Rien n'est écrit, la base n'est que lue.
 */
export async function previewSchemaChange(
	input: SchemaChangeInput,
	adapters: Partial<Record<OrmName, OrmAdapter>> = ADAPTERS
): Promise<TunnelSchemaPreviewData> {
	const { adapter, change } = await prepare(input, adapters);
	const names = adapter.previewNames(change);
	return {
		orm: input.project.orm,
		...(names !== undefined ? { names } : {})
	};
}

export async function applySchemaChange(
	input: SchemaChangeInput,
	adapters: Partial<Record<OrmName, OrmAdapter>> = ADAPTERS
): Promise<TunnelSchemaChangeData> {
	const { project, connection } = input;
	const { adapter, change } = await prepare(input, adapters);
	const { native } = change;
	const history = adapter.migrations(connection.engine);
	await adapter.preflight(change);

	const written: Written[] = [];
	let migration: WrittenMigration | undefined;
	let names: TunnelSchemaChangeNames | undefined;
	try {
		if (history) {
			migration = await adapter.writeMigration(change);
			written.push(migration);
		}
		const model = await adapter.patchModel(change);
		written.push(model);
		names = model.names;
		await adapter.validate(change);
	} catch (err) {
		undo(written);
		throw err;
	}
	const result = (
		applied: boolean,
		checks: readonly TunnelSchemaCheck[]
	): TunnelSchemaChangeData => ({
		orm: project.orm,
		...(migration !== undefined ? { migration: migration.name } : {}),
		files: written.flatMap((w) => w.files),
		applied,
		checks,
		...(names !== undefined ? { names } : {})
	});

	if (!project.apply) {
		return result(false, [
			...(await nativeChecks(adapter, change, migration, false)),
			{ name: "structure", skipped: "base non touchée (apply = false)" }
		]);
	}
	try {
		if (migration !== undefined) await adapter.apply(change, migration);
		else await connection.execute(native);
	} catch (err) {
		const notes: string[] = [];
		try {
			if (migration !== undefined) await adapter.rollback(change, migration);
		} catch (rollbackErr) {
			notes.push(
				`Retour arrière de l'historique incomplet : ${messageOf(rollbackErr)}`
			);
		}
		const left = await restoreDatabase(change, err);
		if (left !== undefined) notes.push(left);
		undo(written);
		// Dit après l'erreur de l'outil : celle de Prisma annonce une migration
		// à résoudre, que le retour arrière vient de résoudre.
		throw new SchemaChangeError(
			[
				messageOf(err),
				...(notes.length === 0
					? [
							migration !== undefined
								? "Rien n'a changé : migration annulée, modèle et base comme avant."
								: "Rien n'a changé : modèle et base comme avant."
						]
					: notes.map((note) => `(${note})`))
			].join("\n")
		);
	}
	return result(true, [
		...(await nativeChecks(adapter, change, migration, true)),
		await structureCheck(change)
	]);
}

/** Les contrôles ne défont rien : une erreur devient un contrôle non exécuté. */
async function nativeChecks(
	adapter: OrmAdapter,
	change: SchemaChange,
	migration: WrittenMigration | undefined,
	applied: boolean
): Promise<TunnelSchemaCheck[]> {
	try {
		return await adapter.check(change, migration, applied);
	} catch (err) {
		return [{ name: "model-database", skipped: messageOf(err) }];
	}
}

/** Schéma attendu d'après le DDL, comparé à l'introspection d'après (ADR-037 D5). */
async function structureCheck(
	change: SchemaChange
): Promise<TunnelSchemaCheck> {
	try {
		const after = await change.connection.introspect();
		const differences = compareSchemas(
			applyDdlToSchema(change.before, change.plan),
			after,
			ddlScope(change.plan, change.before)
		);
		return differences.length === 0
			? { name: "structure", ok: true }
			: { name: "structure", ok: false, differences };
	} catch (err) {
		return { name: "structure", skipped: messageOf(err) };
	}
}

/**
 * Base remise comme avant l'échec, puis vérifiée. Postgres annule un fichier
 * de migration entier (transaction implicite), sauf `CREATE INDEX
 * CONCURRENTLY`, qui laisse un index invalide : il est retiré. Ce qui reste
 * est signalé.
 */
async function restoreDatabase(
	change: SchemaChange,
	failure: unknown
): Promise<string | undefined> {
	try {
		await dropFailedIndex(
			change.connection,
			change.plan,
			change.before,
			failure
		);
		const left = compareSchemas(
			change.before,
			await change.connection.introspect(),
			ddlScope(change.plan, change.before)
		);
		return left.length === 0
			? undefined
			: `La base n'est pas revenue à l'état d'avant : ${left.map(describeDiff).join(" ; ")}`;
	} catch (err) {
		return `Base non vérifiée après l'échec : ${messageOf(err)}`;
	}
}

function describeDiff(d: SchemaDiff): string {
	const where = d.name !== undefined ? `${d.target}.${d.name}` : d.target;
	return `${d.subject} ${where} : ${d.actual} (attendu : ${d.expected})`;
}

/** Le schéma de la connexion, que l'introspection lit. */
function mapperContext(connection: Connection): MapperContext | undefined {
	return connection.namespace !== undefined
		? { namespace: connection.namespace }
		: undefined;
}

/** Étapes annulées de la dernière à la première. */
function undo(written: readonly Written[]): void {
	for (const w of [...written].reverse()) w.undo();
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
