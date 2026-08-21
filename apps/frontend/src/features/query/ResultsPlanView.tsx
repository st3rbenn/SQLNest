/**
 * PM/10 D10 — Vue "Plan" du result panel : compile la source SNQL localement
 * (compile snql, aucun round-trip) et affiche le native query produit avec
 * badges par stage. Complète les 3 vues existantes (tableau/graphique/JSON).
 *
 * Pour Mongo : liste chaque stage du pipeline (`$match`, `$lookup`, `$project`,
 * `$dateTrunc`, `$setIsSubset`, etc.) avec :
 *  - Badge `native` — stage poussé au driver MongoDB
 *  - Badge `lift` — stage synthétisé par PA/1 lift-lookup (correlated subquery)
 *  - Badge `materialize` — stage lié à matérialisation runtime (PA/2 join CTE)
 *  - Badge `write` — stage terminal ($merge, $out) ou operation update-pipeline
 *
 * Pour PG : affiche le SQL text + params, distingue query vs mutation.
 *
 * L'inférence des badges est heuristique (basée sur les operator patterns) —
 * elle ne remplace pas l'instrumentation planner (v2). Le user voit
 * néanmoins la structure exacte du native produit.
 */

import type { NativeQuery } from "@sqlnest/snql";
import {
	compile,
	getMapper,
	lowerLet,
	lowerMutation,
	lowerTransaction,
	parse,
	type SchemaModel,
	type SupportedEngine,
	tokenize
} from "@sqlnest/snql";
import type { CSSProperties } from "react";
import { useMemo } from "react";

interface ResultsPlanViewProps {
	readonly source: string;
	readonly engine: string;
	readonly schema: SchemaModel | undefined;
}

type StageBadge = "native" | "lift" | "materialize" | "write" | "compensate";

interface PlanStage {
	readonly index: number;
	readonly operator: string;
	readonly payload: unknown;
	readonly badge: StageBadge;
	readonly hint?: string;
}

const containerStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	overflow: "auto",
	display: "flex",
	flexDirection: "column",
	gap: 8,
	fontSize: 12,
	fontFamily:
		"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
};

const headerStyle: CSSProperties = {
	padding: "8px 10px",
	background: "var(--sqlnest-surface-hover)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 4,
	color: "var(--sqlnest-text-secondary)",
	fontSize: 11
};

const emptyStyle: CSSProperties = {
	padding: 16,
	color: "var(--sqlnest-text-tertiary)",
	textAlign: "center",
	fontStyle: "italic"
};

const stageRowStyle: CSSProperties = {
	display: "flex",
	gap: 8,
	alignItems: "flex-start",
	padding: "6px 10px",
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 4
};

const stageIndexStyle: CSSProperties = {
	minWidth: 20,
	color: "var(--sqlnest-text-tertiary)",
	fontSize: 11
};

const stageOperatorStyle: CSSProperties = {
	color: "var(--sqlnest-text-primary)",
	fontWeight: 600,
	minWidth: 100
};

const stagePayloadStyle: CSSProperties = {
	flex: 1,
	color: "var(--sqlnest-text-secondary)",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	fontSize: 11
};

function badgeStyle(badge: StageBadge): CSSProperties {
	const map: Record<StageBadge, string> = {
		native: "var(--sqlnest-success)",
		lift: "var(--sqlnest-info, #4a9eff)",
		materialize: "var(--sqlnest-warning)",
		write: "var(--sqlnest-danger)",
		compensate: "var(--sqlnest-text-tertiary)"
	};
	return {
		display: "inline-block",
		padding: "1px 6px",
		borderRadius: 3,
		fontSize: 10,
		fontWeight: 600,
		textTransform: "uppercase" as const,
		background: `color-mix(in srgb, ${map[badge]} 20%, transparent)`,
		color: map[badge],
		border: `1px solid ${map[badge]}`,
		letterSpacing: 0.4,
		lineHeight: "14px"
	};
}

export function ResultsPlanView({
	source,
	engine,
	schema
}: ResultsPlanViewProps): React.ReactNode {
	const compiled = useMemo(() => {
		const trimmed = source.trim();
		if (trimmed.length === 0) return { kind: "empty" as const };
		const engineName: SupportedEngine =
			engine === "mongodb" ? "mongodb" : "postgres";
		try {
			return {
				kind: "ok" as const,
				native: compileForExplain(trimmed, engineName, schema)
			};
		} catch (err) {
			return {
				kind: "error" as const,
				message: err instanceof Error ? err.message : String(err)
			};
		}
	}, [source, engine, schema]);

	if (compiled.kind === "empty") {
		return <div style={emptyStyle}>Aucune requête à expliquer.</div>;
	}
	if (compiled.kind === "error") {
		return (
			<div style={emptyStyle}>
				<div>Impossible de compiler la requête pour l'expliquer.</div>
				<div
					style={{
						marginTop: 6,
						color: "var(--sqlnest-danger)",
						fontStyle: "normal",
						fontSize: 11
					}}
				>
					{compiled.message}
				</div>
			</div>
		);
	}

	const native = compiled.native;
	const stages = analyzeNative(native);

	return (
		<div style={containerStyle}>
			<div style={headerStyle}>
				<span style={{ fontWeight: 600 }}>{native.engine}</span>
				<span style={{ marginLeft: 8 }}>· kind: {native.kind}</span>
				{"collection" in native && typeof native.collection === "string" ? (
					<span style={{ marginLeft: 8 }}>· collection: {native.collection}</span>
				) : null}
				<span style={{ marginLeft: 8 }}>· {stages.length} stage(s)</span>
			</div>
			{stages.length === 0 ? (
				<div style={emptyStyle}>Aucun stage à afficher pour ce native query.</div>
			) : (
				stages.map((s) => (
					<div key={s.index} style={stageRowStyle}>
						<span style={stageIndexStyle}>{s.index}.</span>
						<span style={stageOperatorStyle}>{s.operator}</span>
						<span style={badgeStyle(s.badge)}>{s.badge}</span>
						<span style={stagePayloadStyle}>
							{typeof s.payload === "string"
								? s.payload
								: JSON.stringify(s.payload, null, 2)}
						</span>
					</div>
				))
			)}
		</div>
	);
}

/**
 * Compile la source SNQL vers le native query correspondant selon le kind
 * de statement. `compile()` de snql est read-only (throw sur mutation), il
 * faut router manuellement vers lowerMutation/lowerLet/lowerTransaction.
 * Mirror du dispatch dans `packages/snql/src/test-utils/parity.ts`.
 */
function compileForExplain(
	source: string,
	engine: SupportedEngine,
	schema: SchemaModel | undefined
): NativeQuery {
	const statement = parse(tokenize(source));
	const mapper = getMapper(engine);
	switch (statement.operation) {
		case "select": {
			const { native } = compile(source, { engine, schema });
			return native;
		}
		case "insert":
		case "update":
		case "delete":
			return mapper.mapMutation(lowerMutation(statement, schema));
		case "transaction":
			if (mapper.mapTransaction === undefined) {
				throw new Error(
					`Le moteur '${engine}' ne supporte pas les transactions.`
				);
			}
			return mapper.mapTransaction(
				lowerTransaction(statement, schema)
			) as NativeQuery;
		case "let":
			if (mapper.mapLet === undefined) {
				throw new Error(
					`Le moteur '${engine}' matérialise le 'let' au runtime — pas de plan statique à afficher.`
				);
			}
			return mapper.mapLet(lowerLet(statement, schema));
		case "raw":
		case "introspect":
		case "savepoint":
			throw new Error(
				`Explain non supporté pour l'operation '${statement.operation}'.`
			);
	}
}

function analyzeNative(native: NativeQuery): PlanStage[] {
	// SQL PG : un seul "stage" = le SQL text (params bindés séparément).
	if (native.kind === "sql") {
		return [
			{
				index: 1,
				operator: "SQL",
				payload: native.text,
				badge: "native",
				hint: `${native.params.length} param(s) bindés`
			}
		];
	}
	if (native.kind === "sql-transaction") {
		const steps = (native as { steps?: readonly unknown[] }).steps ?? [];
		return steps.map((step, i) => ({
			index: i + 1,
			operator: "SQL step",
			payload: step,
			badge: "native" as StageBadge
		}));
	}
	if (native.kind === "mongo") {
		return native.pipeline.map((stage, i) => {
			const operator = Object.keys(stage)[0] ?? "?";
			const payload = (stage as Record<string, unknown>)[operator];
			return {
				index: i + 1,
				operator,
				payload,
				badge: badgeForMongoStage(operator, stage, native.pipeline, i)
			};
		});
	}
	if (native.kind === "mongo-write") {
		const w = native as unknown as {
			op: string;
			filter?: unknown;
			update?: unknown;
			documents?: unknown;
			pipeline?: readonly Record<string, unknown>[];
		};
		if (Array.isArray(w.pipeline)) {
			return w.pipeline.map((stage, i) => {
				const operator = Object.keys(stage)[0] ?? "?";
				return {
					index: i + 1,
					operator,
					payload: stage[operator],
					badge: badgeForMongoStage(operator, stage, w.pipeline!, i)
				};
			});
		}
		const stages: PlanStage[] = [];
		if (w.filter !== undefined) {
			stages.push({
				index: 1,
				operator: `${w.op} filter`,
				payload: w.filter,
				badge: "write"
			});
		}
		if (w.update !== undefined) {
			stages.push({
				index: stages.length + 1,
				operator: `${w.op} update`,
				payload: w.update,
				badge: "write"
			});
		}
		if (w.documents !== undefined) {
			stages.push({
				index: stages.length + 1,
				operator: `${w.op} documents`,
				payload: w.documents,
				badge: "write"
			});
		}
		return stages;
	}
	if (native.kind === "mongo-transaction") {
		const steps = (native as { steps?: readonly unknown[] }).steps ?? [];
		return steps.map((step, i) => {
			const s = step as { kind?: string };
			return {
				index: i + 1,
				operator: `tx step (${s.kind ?? "?"})`,
				payload: step,
				badge: s.kind === "write" || s.kind === "savepoint" ? "write" : "native"
			};
		});
	}
	return [];
}

/**
 * Heuristique de badge pour un stage Mongo. Détecte les patterns typiques de
 * lift-lookup (PA/1 correlated) et de matérialisation, sinon "native".
 */
function badgeForMongoStage(
	operator: string,
	stage: Record<string, unknown>,
	pipeline: readonly Record<string, unknown>[],
	index: number
): StageBadge {
	// PA/1 lift-lookup : $lookup avec `let` (correlated → sub-pipeline)
	if (operator === "$lookup") {
		const lookup = stage.$lookup as Record<string, unknown> | undefined;
		if (
			lookup !== undefined &&
			typeof lookup === "object" &&
			"let" in lookup
		) {
			return "lift";
		}
		return "native";
	}
	// $unset — souvent la 3ème partie du triple lift-lookup (PA/1)
	if (operator === "$unset") {
		// Si un $lookup avec `let` a précédé récemment → suffixe lift
		for (let i = index - 1; i >= Math.max(0, index - 3); i -= 1) {
			const prev = pipeline[i];
			if (prev && "$lookup" in prev) {
				const lu = prev.$lookup as Record<string, unknown> | undefined;
				if (lu !== undefined && "let" in lu) return "lift";
			}
		}
		return "native";
	}
	// $merge / $out — write terminal
	if (operator === "$merge" || operator === "$out") return "write";
	// PA/7 : $dateTrunc = cast(_ as date) émule date-only
	if (operator === "$dateTrunc") return "native";
	return "native";
}
