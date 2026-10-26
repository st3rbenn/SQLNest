/**
 * Types, défauts et actions SNQL écrits en Prisma, pour que le modèle décrive
 * exactement le DDL que SNQL génère (zéro écart à `prisma migrate diff`).
 * Tables vérifiées sur le vrai Prisma : PostgreSQL et SQL Server.
 */

import type {
	DdlDefault,
	OnDeleteRule,
	OnUpdateRule,
	SnqlType
} from "@sqlnest/snql";
import type { PrismaArgument } from "./attributes";

export type PrismaProvider = "postgresql" | "sqlserver";

export interface PrismaScalar {
	/** Type Prisma : `String`, `Int`, le nom d'un enum. */
	readonly type: string;
	/** Type natif quand le défaut de Prisma diffère du DDL SNQL : `@db.Uuid`. */
	readonly native?: string;
}

const POSTGRES: Readonly<Record<SnqlType, PrismaScalar>> = {
	string: { type: "String" },
	int: { type: "Int" },
	bigint: { type: "BigInt" },
	float: { type: "Float" },
	decimal: { type: "Decimal", native: "@db.Decimal" },
	bool: { type: "Boolean" },
	date: { type: "DateTime", native: "@db.Timestamptz(6)" },
	json: { type: "Json" },
	// Un tableau SNQL est rangé en jsonb.
	array: { type: "Json" },
	uuid: { type: "String", native: "@db.Uuid" },
	enum: { type: "String" },
	unknown: { type: "String" }
};

const SQLSERVER: Readonly<Record<SnqlType, PrismaScalar>> = {
	string: { type: "String", native: "@db.NVarChar(Max)" },
	int: { type: "Int" },
	bigint: { type: "BigInt" },
	float: { type: "Float" },
	decimal: { type: "Decimal", native: "@db.Decimal(38, 10)" },
	bool: { type: "Boolean" },
	date: { type: "DateTime", native: "@db.DateTimeOffset" },
	// Ni JSON ni enum pour Prisma sous SQL Server : du texte.
	json: { type: "String", native: "@db.NVarChar(Max)" },
	array: { type: "String", native: "@db.NVarChar(Max)" },
	uuid: { type: "String", native: "@db.UniqueIdentifier" },
	enum: { type: "String", native: "@db.NVarChar(450)" },
	unknown: { type: "String", native: "@db.NVarChar(Max)" }
};

/** Texte indexable sous SQL Server : SNQL range une clé en `nvarchar(450)`. */
export const SQLSERVER_KEY_STRING = "@db.NVarChar(450)";

/**
 * Type Prisma d'une colonne SNQL. `key` : colonne d'une clé ou d'un index
 * (SQL Server y range le texte en `nvarchar(450)`).
 */
export function prismaScalar(
	type: SnqlType,
	provider: PrismaProvider,
	options: { readonly enumTypeName?: string; readonly key?: boolean } = {}
): PrismaScalar {
	if (provider === "postgresql") {
		return type === "enum" && options.enumTypeName !== undefined
			? { type: options.enumTypeName }
			: POSTGRES[type];
	}
	const scalar = SQLSERVER[type];
	return type === "string" && options.key === true
		? { ...scalar, native: SQLSERVER_KEY_STRING }
		: scalar;
}

/** Valeur de `@default(…)` d'un défaut SNQL ; `undefined` pour `null`. */
export function prismaDefaultValue(
	value: DdlDefault,
	provider: PrismaProvider,
	isEnum: boolean
): string | undefined {
	if (value === null) return undefined;
	if (typeof value === "object" && "kind" in value) {
		if (value.kind === "fn") {
			if (value.fn === "now") {
				return provider === "postgresql"
					? "now()"
					: 'dbgenerated("sysdatetimeoffset()")';
			}
			return provider === "postgresql"
				? 'dbgenerated("gen_random_uuid()")'
				: 'dbgenerated("newid()")';
		}
		if (value.kind === "decimal") return value.raw;
		if (value.kind === "json") return JSON.stringify(value.raw);
	}
	if (typeof value === "string") {
		return isEnum && provider === "postgresql" ? value : JSON.stringify(value);
	}
	return String(value);
}

/** Moteur SNQL d'un fournisseur : la limite de longueur des noms en dépend. */
export function engineOf(provider: PrismaProvider): "postgres" | "mssql" {
	return provider === "postgresql" ? "postgres" : "mssql";
}

const ACTIONS: Readonly<Record<OnDeleteRule, string>> = {
	restrict: "Restrict",
	cascade: "Cascade",
	"set-null": "SetNull"
};

/** Action Prisma d'une règle SNQL. SQL Server n'a pas de Restrict : NoAction. */
export function prismaAction(
	rule: OnDeleteRule | OnUpdateRule,
	provider: PrismaProvider
): string {
	return provider === "sqlserver" && rule === "restrict"
		? "NoAction"
		: ACTIONS[rule];
}

export interface ReferentialActions {
	readonly onDelete: string;
	readonly onUpdate: string;
}

/**
 * Actions que Prisma suppose quand rien n'est écrit : `onDelete` Restrict
 * (SetNull si la relation est optionnelle, NoAction sous SQL Server),
 * `onUpdate` Cascade.
 */
export function defaultActions(
	optional: boolean,
	provider: PrismaProvider
): ReferentialActions {
	return {
		onDelete: optional
			? "SetNull"
			: provider === "sqlserver"
				? "NoAction"
				: "Restrict",
		onUpdate: "Cascade"
	};
}

/** `onDelete` / `onUpdate` à écrire : ceux qui diffèrent du défaut de Prisma. */
export function referentialArguments(
	actions: ReferentialActions,
	optional: boolean,
	provider: PrismaProvider
): PrismaArgument[] {
	const defaults = defaultActions(optional, provider);
	return [
		...(actions.onDelete !== defaults.onDelete
			? [{ key: "onDelete", value: actions.onDelete }]
			: []),
		...(actions.onUpdate !== defaults.onUpdate
			? [{ key: "onUpdate", value: actions.onUpdate }]
			: [])
	];
}
