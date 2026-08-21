import type {
	MongoIntrospectQuery,
	MongoQuery,
	MongoStage,
	MongoWriteQuery,
	NativeQuery
} from "../codegen/mapper";
import { SnqlError } from "../diagnostics";
import { getMapper } from "../index";
import { lower, lowerLet, lowerMutation, lowerTransaction } from "../ir/lower";
import { tokenize } from "../lexer/lexer";
import { parse } from "../parser/parser";
import { capabilitiesFor } from "../planner/capabilities";
import type { PlannerErrorCode } from "../planner/errors/registry";
import {
	assertIntrospectSupported,
	assertLetSupported,
	assertMutationCastTargetsSupported,
	assertMutationInsertSelectSupported,
	assertMutationUpsertSupported,
	assertMutationWriteJoinSupported,
	assertTransactionSupported,
	plan
} from "../planner/planner";
import type { SchemaModel } from "../schema/model";

/**
 * ADR-024 D11 — helpers test-utils factorisés depuis les 25 fichiers .test.ts
 * PG existants qui redéclaraient localement `pgSql`. Consommés par les sibling
 * tests `-mongo-e2e.test.ts` créés en PM/2..PM/8 pour vérifier :
 *  1. shape codegen Mongo (assertMongoPipeline) — analogue à pgSql().text
 *  2. refus typé au planner (assertMongoRefused) — code du registre D13
 *
 * Conventions figées :
 *  - `sourceOf(engine, source, schema?)` dispatch auto SELECT vs MUTATION vs
 *    LET vs TRANSACTION selon `statement.operation` — mêmes chemins que run.ts.
 *  - Zéro dépendance à vitest côté runtime — les helpers throw des `Error`
 *    plain, le caller consomme avec le harness de son choix (`expect(() => ...)
 *    .toThrow()` en vitest, `assert.throws` en node:assert).
 */

/**
 * Compile une source SNQL vers la requête native Postgres. Dispatch auto sur
 * le type de statement — équivalent des `pgSql()` locaux redéclarés dans
 * subquery-t211-e2e / insert-select-t214-e2e / mutation-join-t214-e2e /
 * upsert-t213-e2e / aggregate-t26-e2e / group-by-t27-e2e / window-fn-t29-e2e /
 * typecheck-t2115-e2e / cast.e2e / conditional-t25-e2e / correlated-subquery-t212-e2e.
 */
export function pgSql(
	source: string,
	schema?: SchemaModel
): { text: string; params: readonly unknown[] } {
	const native = pgNative(source, schema);
	if (native.kind !== "sql") {
		throw new Error(
			`pgSql: 'sql' attendu, reçu '${native.kind}' — utilise pgTransaction pour un statement transaction.`
		);
	}
	return { text: native.text, params: native.params };
}

/**
 * Compile une source SNQL vers la requête native Mongo. Dispatch auto sur le
 * type de statement — supporte SELECT (aggregate pipeline), MUTATION (write),
 * LET (bindings + body), INTROSPECT (list/describe), RAW (passthrough).
 * L'output typé permet aux tests de matcher précisément sur `pipeline`,
 * `documents`, `filter`, etc. sans caster manuellement.
 */
export function mongoSql(source: string, schema?: SchemaModel): NativeQuery {
	return mongoNative(source, schema);
}

/**
 * Extrait uniquement le pipeline d'aggregation Mongo pour un SELECT — usage
 * le plus fréquent, évite au caller de destructurer manuellement le shape
 * discriminé de MongoQuery.
 */
export function mongoPipeline(
	source: string,
	schema?: SchemaModel
): readonly MongoStage[] {
	const native = mongoNative(source, schema);
	if (native.kind !== "mongo") {
		throw new Error(
			`mongoPipeline: 'mongo' attendu (SELECT), reçu '${native.kind}' — utilise mongoWrite/mongoIntrospect selon le statement.`
		);
	}
	return (native as MongoQuery).pipeline;
}

/**
 * Extrait la requête write Mongo pour un INSERT/UPDATE/DELETE/UPSERT. Le
 * dispatch codegen est identique à celui de run.ts (`getMapper("mongodb").
 * mapMutation(lowerMutation(stmt))`).
 */
export function mongoWrite(
	source: string,
	schema?: SchemaModel
): MongoWriteQuery {
	const native = mongoNative(source, schema);
	if (native.kind !== "mongo-write") {
		throw new Error(
			`mongoWrite: 'mongo-write' attendu, reçu '${native.kind}'.`
		);
	}
	return native as MongoWriteQuery;
}

/**
 * Vérifie qu'une source SNQL est refusée par le planner/lower/codegen Mongo
 * avec le code exact `expectedCode` (typé du registre D13). Message d'échec
 * détaillé quand l'erreur remonte avec un autre code — critique pour éviter
 * les tests qui passent sur un refus non-lié (ex. parse error au lieu de
 * planner refus attendu).
 *
 * Le code est typé `PlannerErrorCode` : TS refuse un code hors registre à la
 * compilation — verrou anti-régression sur la contrainte non-négociable #1
 * de l'ADR-024 (pattern refus atomique). Pour un code hors registre planner
 * (parse_/lower_/codegen_), passe la string directement via le second overload.
 */
export function assertMongoRefused(
	source: string,
	expectedCode: PlannerErrorCode | string,
	schema?: SchemaModel
): SnqlError {
	try {
		mongoNative(source, schema);
	} catch (e) {
		if (!(e instanceof SnqlError)) {
			throw new Error(
				`assertMongoRefused: attendu SnqlError code='${expectedCode}', reçu ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`
			);
		}
		if (e.code !== expectedCode) {
			throw new Error(
				`assertMongoRefused: code attendu '${expectedCode}', reçu '${e.code}' — message: ${e.message}`
			);
		}
		return e;
	}
	throw new Error(
		`assertMongoRefused: aucune erreur levée — source compilée sans refus. Source : ${source}`
	);
}

/**
 * Compile et retourne le pipeline Mongo — sucre pour `expect(mongoPipeline(...)).
 * toEqual(shape)` en vitest. Ne fait pas l'assert lui-même pour rester
 * agnostique du harness de test.
 */
export function assertMongoPipeline(
	source: string,
	schema?: SchemaModel
): readonly MongoStage[] {
	return mongoPipeline(source, schema);
}

/**
 * Extrait un native query Mongo introspect (list tables / describe / list
 * indexes) — usage plus rare, exposé pour cohérence avec mongoWrite.
 */
export function mongoIntrospect(
	source: string,
	schema?: SchemaModel
): MongoIntrospectQuery {
	const native = mongoNative(source, schema);
	if (native.kind !== "mongo-introspect") {
		throw new Error(
			`mongoIntrospect: 'mongo-introspect' attendu, reçu '${native.kind}'.`
		);
	}
	return native as MongoIntrospectQuery;
}

// --- Internal dispatch ---

function pgNative(
	source: string,
	schema: SchemaModel | undefined
): NativeQuery {
	return dispatchNative("postgres", source, schema);
}

function mongoNative(
	source: string,
	schema: SchemaModel | undefined
): NativeQuery {
	return dispatchNative("mongodb", source, schema);
}

/**
 * Dispatch complet — mirror exact du chemin runtime run.ts. Chaque type de
 * statement passe par ses asserts capacité + son mapper. Critique pour que
 * les tests parité déclenchent les refus au bon étage (planner) plutôt que
 * de rencontrer une erreur codegen tardive qui masque le refus attendu.
 */
function dispatchNative(
	engine: "postgres" | "mongodb",
	source: string,
	schema: SchemaModel | undefined
): NativeQuery {
	const statement = parse(tokenize(source));
	const capabilities = capabilitiesFor(engine);
	if (capabilities === undefined) {
		throw new Error(`Moteur inconnu '${engine}' dans dispatchNative`);
	}
	const mapper = getMapper(engine);
	switch (statement.operation) {
		case "select": {
			// plan() applique tous les asserts capacité (subquery, agg unique,
			// cast, etc.) — identique au chemin runQuery pour un select.
			const logicalPlan = lower(statement, schema);
			const physical = plan(logicalPlan, capabilities);
			return mapper.map(physical.pushdown);
		}
		case "insert":
		case "update":
		case "delete": {
			const mutationPlan = lowerMutation(statement, schema);
			assertMutationCastTargetsSupported(mutationPlan, capabilities);
			assertMutationUpsertSupported(mutationPlan, capabilities);
			assertMutationWriteJoinSupported(mutationPlan, capabilities);
			assertMutationInsertSelectSupported(mutationPlan, capabilities);
			return mapper.mapMutation(mutationPlan);
		}
		case "let": {
			const letPlan = lowerLet(statement, schema);
			assertLetSupported(letPlan, capabilities);
			if (mapper.mapLet === undefined) {
				throw new Error(
					`${engine}: mapLet non implémenté — un refus assertLetSupported était attendu au planner.`
				);
			}
			return mapper.mapLet(letPlan);
		}
		case "transaction": {
			const txPlan = lowerTransaction(statement, schema);
			assertTransactionSupported(txPlan, capabilities);
			if (mapper.mapTransaction === undefined) {
				throw new Error(
					`${engine}: mapTransaction non implémenté — un refus assertTransactionSupported était attendu au planner.`
				);
			}
			return mapper.mapTransaction(txPlan) as NativeQuery;
		}
		case "introspect":
		case "raw":
			// Introspect passe par assertIntrospectSupported au planner ; raw
			// n'a pas d'assert planner (codegen direct dispatchant sur payload
			// shape). Ces cas ont des helpers dédiés dans les tests concernés
			// (introspect-t31-e2e / raw-t34-e2e) — pas de dispatch générique ici.
			void assertIntrospectSupported;
			throw new Error(
				`${engine}: operation '${statement.operation}' non couverte par ces helpers — utiliser un test dédié.`
			);
	}
}
