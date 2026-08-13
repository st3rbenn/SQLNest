/**
 * Point d'entrée public du registre de fonctions SNQL. Import unique pour le
 * lower, le planner, les codegens et les tests.
 */

export { checkArity, describeArity } from "./arity";
export { SNQL_FUNCTIONS } from "./builtins";
export {
	createRegistry,
	type Arity,
	type EngineName,
	type EngineRenderer,
	type FunctionEntry,
	type FunctionKind,
	type FunctionRegistry,
	type NullBehavior,
	type RenderContext,
	type TypeSpec
} from "./registry";
