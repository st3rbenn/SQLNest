/**
 * Corps de la console SNQL — la même mécanique tabs / éditeur / résultats
 * / split-resize que la page fullscreen, mais SANS le wrapper
 * `position: fixed; inset: 0`. Utilisé par :
 *
 *   - `ConsolePage` (route `/query`) : wrap dans un shell fullscreen.
 *   - `ConsoleNode` (node React Flow T5) : wrap dans un node canvas.
 *
 * Le shell parent fournit la surface (fullscreen ou node) et les
 * hotkeys qui dépendent du contexte (Escape back, ⌘⇧K détacher). Cet
 * inner ne gère que ce qui est commun aux deux modes : ⌘T / ⌘W tabs,
 * ⌘⇧F format, ⌘⏎ run via SnqlEditor keymap.
 *
 * ─── Variantes ─────────────────────────────────────────────────────────
 *   variant="route"  → header standard (Back Canvas / Fermer + Détacher),
 *                       parent gère la nav via `onDetach`.
 *   variant="node"   → header sans Back/Détacher, parent injecte
 *                       `extraLeftActions` (bouton Focus/Collapse T5).
 *
 * ─── Isolation multi-instances ────────────────────────────────────────
 * `tabsScopeSuffix` (optionnel) permet à plusieurs consoles sur la même
 * connexion (ex : plusieurs nodes T5 dans le canvas) d'avoir chacune
 * leurs tabs propres. Sans suffix, comportement legacy — une console
 * partagée par connId.
 */

import { useHotkeys, useLocalStorage } from "@mantine/hooks";
import { formatSnql, parse, tokenize } from "@sqlnest/snql";
import { showNotification } from "@sqlnest/design-system";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState
} from "react";
import { injectSchemaEventsCollection } from "../checksum-history/schemaEventsCollection";
import { useDbConnections } from "../db-connections/useDbConnections";
import { useConsolePersistence } from "../schema/console/useConsolePersistence";
import { useSchema } from "../schema/useSchema";
import { AutorunRefusedBanner } from "./AutorunRefusedBanner";
import { runConsoleQuery, useConsoleQuery } from "./consoleQueriesStore";
import { ConsoleHeader, type ConsoleHeaderVariant } from "./ConsoleHeader";
import { ConsoleResultsPanel } from "./ConsoleResultsPanel";
import { SnqlEditor, type SnqlEditorHandle } from "./SnqlEditor";
import { fetchPreviewCount, type PreviewResult } from "./preview";
import { classifyRuntimeError } from "./rollbackClassify";
import {
	supportsTransactionsForEngine,
	wrapInTransaction
} from "./transactionWrap";
import {
	collectUnfilteredWrites,
	hasAnyUnfilteredWrite,
	type UnfilteredFinding
} from "./unfilteredWrites";
import { useConsoleTabs } from "./useConsoleTabs";
import { useLiveDiagnostics } from "./useLiveDiagnostics";
import { type SerializedSpan, SnqlRuntimeError } from "./useRunQuery";
import { WriteConfirmBar } from "./WriteConfirmBar";

/**
 * Type guard défensif : la source pgError peut avoir été sérialisée par
 * msgpackr ou Zod et remonter un span mal formé (`null`, tuple d'arité
 * différente, valeurs non numériques). Filtre au point de consommation
 * plutôt que d'assumer la shape.
 */
function isSerializedSpan(value: unknown): value is SerializedSpan {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		typeof value[0] === "number" &&
		typeof value[1] === "number"
	);
}

const SPLIT_STORAGE_KEY = "sqlnest.console.editorHeight";
const SPLIT_MIN_TOP = 120;
const SPLIT_MIN_BOTTOM = 200;
const SPLIT_DEFAULT = 220;

const shellStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	width: "100%",
	height: "100%",
	background: "var(--sqlnest-canvas-bg)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
	overflow: "hidden"
};

const bodyStyle: CSSProperties = {
	flex: 1,
	display: "flex",
	flexDirection: "column",
	minHeight: 0
};

const editorWrapperStyle: CSSProperties = {
	background: "var(--sqlnest-canvas-bg)",
	overflow: "hidden",
	minHeight: SPLIT_MIN_TOP,
	display: "flex",
	flexDirection: "column"
};

const editorFillStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	display: "flex",
	flexDirection: "column"
};

const resizeHandleStyle: CSSProperties = {
	height: 4,
	cursor: "ns-resize",
	background: "var(--sqlnest-border-subtle)",
	transition: "background-color 120ms ease",
	flexShrink: 0
};

export interface ConsoleShellInnerProps {
	readonly teamSlug: string;
	readonly connId: string;
	readonly initialSource?: string;
	readonly initialAutorun?: boolean;
	/** Variante du header — voir le doc du fichier. */
	readonly variant?: ConsoleHeaderVariant;
	/** Détacher = popout. Requis en `route`, ignoré en `node`. */
	readonly onDetach?: () => void;
	/** Popout window flag — propagé au header (label "Fermer" au lieu de
	 * "Canvas" en variant route). Non pertinent en `node`. */
	readonly isPopout?: boolean;
	/** Slot pour actions en-tête gauche (utilisé par ConsoleNode pour le
	 * bouton Focus/Collapse). */
	readonly extraLeftActions?: React.ReactNode;
	/** Isole les tabs de cette instance — voir useConsoleTabs. */
	readonly tabsScopeSuffix?: string;
}

export function ConsoleShellInner({
	teamSlug,
	connId,
	initialSource,
	initialAutorun,
	variant = "route",
	onDetach,
	isPopout = false,
	extraLeftActions,
	tabsScopeSuffix
}: ConsoleShellInnerProps): React.ReactNode {
	const { data: connections } = useDbConnections(teamSlug);
	const connection = useMemo(
		() => connections?.find((c) => c.id === connId),
		[connections, connId]
	);
	const engine = connection?.engine ?? "postgres";

	const schemaQuery = useSchema(connId, teamSlug);
	// Inject la table système `schema_events` dans le SchemaModel côté console
	// — la vraie DB user ignore l'existence de cette table (elle vit dans le
	// backend SQLNest), mais l'autocomplete SNQL doit la voir pour proposer
	// `find schema_events pick …` sans erreur "table inconnue". L'exécution
	// est routée par useRunQuery vers l'API SQLNest, jamais vers la DB user.
	const schemaWithSystem = useMemo(() => {
		if (!schemaQuery.data) return schemaQuery.data;
		return injectSchemaEventsCollection(
			schemaQuery.data as unknown as import("../schema/schema-model").SchemaModel
		) as unknown as typeof schemaQuery.data;
	}, [schemaQuery.data]);

	const tabs = useConsoleTabs(connId, tabsScopeSuffix);
	// History scopée par connectionId — pas de leak dev→prod
	// cross-connection.
	const persistence = useConsolePersistence(engine, connId);

	// La query state vit dans un store singleton (voir consoleQueriesStore)
	// pour survivre au remount du shell — sinon le switch fullscreen ↔ normal
	// (portal T5) tuerait la mutation en cours. Key stable par (connId,
	// scope de node éventuel, tab actif) : chaque tab a son propre run state.
	const activeTabIdEarly = tabs.activeTab.id;
	const queryKey = useMemo(
		() =>
			tabsScopeSuffix
				? `${connId}:${tabsScopeSuffix}:${activeTabIdEarly}`
				: `${connId}:${activeTabIdEarly}`,
		[connId, tabsScopeSuffix, activeTabIdEarly]
	);
	const queryState = useConsoleQuery(queryKey);

	// Split resize state (persisted, partagé entre toutes les instances —
	// c'est un préférence globale de layout console, pas per-instance).
	const [editorHeight, setEditorHeight] = useLocalStorage<number>({
		key: SPLIT_STORAGE_KEY,
		defaultValue: SPLIT_DEFAULT,
		getInitialValueInEffect: false
	});
	const [isDragging, setIsDragging] = useState(false);
	const bodyRef = useRef<HTMLDivElement>(null);

	function startDrag(e: React.PointerEvent<HTMLDivElement>): void {
		e.preventDefault();
		setIsDragging(true);
	}

	useEffect(() => {
		if (!isDragging) return;
		function onMove(e: PointerEvent): void {
			const rect = bodyRef.current?.getBoundingClientRect();
			if (!rect) return;
			const nextTop = e.clientY - rect.top;
			const maxTop = rect.height - SPLIT_MIN_BOTTOM;
			const clamped = Math.max(SPLIT_MIN_TOP, Math.min(maxTop, nextTop));
			setEditorHeight(clamped);
		}
		function onUp(): void {
			setIsDragging(false);
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [isDragging, setEditorHeight]);

	const activeTabId = tabs.activeTab.id;
	const activeSource = tabs.activeTab.source;

	// Live diagnostic : compile local debounced pendant la frappe. Passé à
	// l'éditeur pour squigglies + gutter badge + tooltip au hover. Zero I/O.
	// Le hook retourne aussi rawStatementSpan pour la décoration
	// permanente dans SnqlEditor.
	const { diag: liveDiagnostic, rawStatementSpan } = useLiveDiagnostics(
		activeSource,
		engine,
		schemaWithSystem ?? undefined
	);

	const editorRef = useRef<SnqlEditorHandle>(null);

	// Extrait tous les spans source SNQL du pgError courant → alimente les
	// squigglies dans l'éditeur. Trois sources :
	//  - Phase 3a : `paramSpans[N-1]` pour chaque `$N` référencé dans le message.
	//  - Phase 3b-lite : `identSpans[column]` (toutes les occurrences) quand
	//    l'erreur pointe une colonne inexistante.
	//  - Phase 3c : `rowSpans` sur violation unique/FK (SQLSTATE 23xxx).
	const errorSpans = useMemo<readonly SerializedSpan[]>(() => {
		const err = queryState.error;
		if (!(err instanceof SnqlRuntimeError) || err.pgError == null) return [];
		const pg = err.pgError;
		const collected: SerializedSpan[] = [];
		// Filtre défensif — msgpackr / Zod optional peuvent remonter `null` en
		// place d'un span absent ; on ne veut ni null ni tuple mal formé.

		// (a) Uniquement les $N réellement mentionnés dans le message (pas TOUS
		// les params bindés — un `column does not exist` ne concerne pas les
		// littéraux WHERE/LIMIT). Le message peut référencer $2 sans $1 → on
		// dédup + suit l'ordre d'apparition.
		if (typeof pg.message === "string" && Array.isArray(pg.paramSpans)) {
			const seenIdx = new Set<number>();
			for (const match of pg.message.matchAll(/\$(\d+)/g)) {
				const idx = Number.parseInt(match[1] ?? "", 10);
				if (!Number.isFinite(idx) || idx <= 0 || seenIdx.has(idx)) continue;
				seenIdx.add(idx);
				const span = pg.paramSpans[idx - 1];
				if (isSerializedSpan(span)) collected.push(span);
			}
		}

		// (b) Idents quotés dans le message (`column "foo" does not exist`,
		// `relation "bar" does not exist`, `operator does not exist: text = int`)
		// → résolution via identSpans + éventuellement pgError.column/table si
		// pg l'a rempli en plus.
		if (pg.identSpans != null && typeof pg.identSpans === "object") {
			const identNames = new Set<string>();
			if (typeof pg.message === "string") {
				for (const match of pg.message.matchAll(/"([^"]+)"/g)) {
					if (match[1] !== undefined) identNames.add(match[1]);
				}
			}
			if (typeof pg.column === "string") identNames.add(pg.column);
			if (typeof pg.table === "string") identNames.add(pg.table);
			for (const name of identNames) {
				const spans = (pg.identSpans as Record<string, unknown>)[name];
				if (!Array.isArray(spans)) continue;
				for (const s of spans) if (isSerializedSpan(s)) collected.push(s);
			}
		}

		// (c) Rows d'un batch INSERT sur violation contrainte (SQLSTATE 23xxx).
		if (pg.code?.startsWith("23") === true && Array.isArray(pg.rowSpans)) {
			for (const s of pg.rowSpans) if (isSerializedSpan(s)) collected.push(s);
		}

		return collected;
	}, [queryState.error]);

	const onFocusSpan = useCallback((span: SerializedSpan) => {
		editorRef.current?.focusSpan(span);
	}, []);

	// Le panel results n'apparaît qu'après la première interaction avec la
	// query (pending, résultat ou erreur). Avant : l'éditeur prend tout
	// l'espace pour ne pas polluer visuellement.
	const hasRun =
		queryState.isPending ||
		queryState.data !== undefined ||
		queryState.error !== null;

	// Injection depuis les search params ?source= (avant tout run éventuel).
	// Le hook n'écrase que si le tab actif est vide (évite d'effacer un
	// travail en cours).
	useEffect(() => {
		if (initialSource && activeSource === "") {
			tabs.updateSource(activeTabId, initialSource);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Pending confirmation state — quand l'user hit ⌘⏎/clic Exécuter sur
	// une source contenant des unfiltered writes, on ne lance PAS
	// runConsoleQuery ; on affiche WriteConfirmBar avec les findings, et
	// on attend le typing du verbe (ou Escape). Le state vit ici (React
	// local) et pas dans le store singleton — la confirm est une décision
	// éphémère par tab, pas un état persistant.
	const [pending, setPending] = useState<readonly UnfilteredFinding[] | null>(
		null
	);
	// Preview count fetché en parallèle du gate — la source rewrite
	// `pick count(*) as _preview_count` est envoyée sur la même route
	// /query (zéro backend delta), timeout 3s. `null` = pas encore fetché
	// ou pending null.
	const [previewResult, setPreviewResult] = useState<PreviewResult | null>(
		null
	);

	// Reset immédiat si la source change pendant qu'un pending est actif
	// — l'AST recalculé peut invalider les findings, la confirmation en
	// attente ne correspond plus au source d'origine.
	useEffect(() => {
		setPending(null);
		setPreviewResult(null);
	}, [activeSource]);

	// Le timeout auto-cancel (15s) est géré par WriteConfirmBar (countdown
	// visible pour l'user). Le parent ne fait que respecter le onCancel
	// remonté.

	// BroadcastChannel cross-window scopé par connectionId. Chaque
	// instance de ConsoleShellInner (route fullscreen, node RF, popout
	// window) partage le même canal pour la même connection. Usage :
	// notifier les autres instances qu'un run vient d'être fired sur cette
	// DB — leur pending state (WriteConfirmBar + preview count) devient
	// potentiellement stale et doit être cancel pour éviter que l'user
	// confirme "de mémoire" sur des données déjà modifiées.
	const channelRef = useRef<BroadcastChannel | null>(null);
	useEffect(() => {
		if (typeof BroadcastChannel === "undefined") return;
		const channel = new BroadcastChannel(`sqlnest.console.${connId}`);
		channelRef.current = channel;
		channel.onmessage = (event: MessageEvent<unknown>) => {
			const data = event.data as { type?: string } | null;
			if (data?.type === "write_executed") {
				// Une autre window/node a run sur cette connection — nos
				// findings/preview peuvent être stale. Cancel pending.
				setPending(null);
				setPreviewResult(null);
			}
		};
		return () => {
			channelRef.current = null;
			channel.close();
		};
	}, [connId]);

	// Lance vraiment le run (bypass unfiltered gate — appelé par
	// confirmExecute après typing OK, ou par execute() si aucun unfiltered).
	const runNow = useCallback(
		(src: string) => {
			// Broadcast pré-fire pour warner les autres windows/nodes de
			// cette connection. Simplification : broadcast pour tous les
			// runs (SELECT inclus) — coût d'un cancel inutile négligeable
			// vs risque de miss un write cross-window.
			channelRef.current?.postMessage({ type: "write_executed" });
			void runConsoleQuery(queryKey, {
				connectionId: connId,
				source: src,
				teamSlug
			});
		},
		[connId, teamSlug, queryKey]
	);

	const execute = useCallback(() => {
		const src = tabs.activeTab.source.trim();
		if (src === "") return;
		// Second gate côté execute() = défense en profondeur. Parse +
		// walker AVANT tout appel réseau : si findings non vides, gate le
		// run derrière WriteConfirmBar. Sinon fire direct comme avant.
		// Si le parse throw (source invalide), l'user voit déjà la squiggly
		// rouge via useLiveDiagnostics — on laisse passer (le CLI renverra
		// l'erreur, le cœur ne refuse pas les writes valides).
		let findings: readonly UnfilteredFinding[] = [];
		try {
			findings = collectUnfilteredWrites(parse(tokenize(src)));
		} catch {
			// Parse KO — pas de gate (feedback signalé ailleurs par live diag).
		}
		if (findings.length > 0) {
			setPending(findings);
			// Fire preview count en parallèle — pas d'await, on ne bloque
			// pas l'affichage de la bar. Timeout 3s à l'intérieur. Le
			// résultat set le state ; si l'user a annulé entre-temps, le
			// setState arrive sur pending===null → WriteConfirmBar déjà
			// unmount, aucun effet visible (setState orphelin).
			setPreviewResult(null);
			const stmt = parse(tokenize(src));
			void fetchPreviewCount({
				originalSource: src,
				statement: stmt,
				connectionId: connId,
				teamSlug
			}).then(setPreviewResult);
			return;
		}
		runNow(src);
	}, [tabs, runNow, connId, teamSlug]);

	const confirmExecute = useCallback(() => {
		const src = tabs.activeTab.source.trim();
		if (src === "") return;
		setPending(null);
		setPreviewResult(null);
		runNow(src);
	}, [tabs, runNow]);

	const cancelPending = useCallback(() => {
		setPending(null);
		setPreviewResult(null);
		editorRef.current?.focus();
	}, []);

	// executeInTransaction — shortcut ⌘⇧⏎ "exec in tx". Bypass la
	// WriteConfirmBar car opt-in tx = signal responsable : la tx
	// elle-même est le garde-fou (rollback sur erreur). Contrôles :
	//  1. Capability check — jamais no-op silencieux, toast danger si
	//     engine incompatible (KV, engine inconnu, Mongo standalone TODO).
	//  2. Double-wrap detection — respect intention utilisateur si tx
	//     racine déjà tapée.
	//  3. Parse KO → envoie tel quel, le CLI renverra l'erreur.
	// Clean le pending state actif (l'user a changé d'avis en pleine confirm).
	const executeInTransaction = useCallback(() => {
		const src = tabs.activeTab.source.trim();
		if (src === "") return;
		if (!supportsTransactionsForEngine(engine)) {
			showNotification({
				color: "red",
				title: "Transactions non supportées",
				message: `L'engine "${engine}" ne supporte pas les transactions — utilisez Ctrl+⏎ (typing du verbe requis pour un write non filtré).`,
				autoClose: 4000
			});
			return;
		}
		let wrappedSource: string;
		try {
			const stmt = parse(tokenize(src));
			wrappedSource = wrapInTransaction(src, stmt).source;
		} catch {
			// Parse KO — envoie la source telle quelle sans wrap, l'user
			// verra l'erreur parser côté CLI. Cohérent execute() classique.
			wrappedSource = src;
		}
		setPending(null);
		setPreviewResult(null);
		runNow(wrappedSource);
	}, [engine, runNow, tabs]);

	// Side-effects post-run — quand une run termine (success ou error), on
	// propage vers `tabs.setLastResult` (rowCount + timing dans la tab bar)
	// et `persistence.addHistory` (only success). Le trigger est le change
	// de `lastRunAt` — set par le store à chaque done. `lastHandledRunAtRef`
	// évite de re-fire si le shell remount avec le state existant.
	const lastHandledRunAtRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		const runAt = queryState.lastRunAt;
		if (runAt === undefined) return;
		if (lastHandledRunAtRef.current === runAt) return;
		lastHandledRunAtRef.current = runAt;
		if (queryState.data && queryState.timingMs !== undefined) {
			tabs.setLastResult(activeTabId, {
				rowCount: queryState.data.rowCount,
				timingMs: queryState.timingMs
			});
			if (queryState.lastSource !== undefined) {
				// Enrichit l'entry avec written flag pour permettre le badge
				// distinct dans l'history dropdown.
				persistence.addHistory(queryState.lastSource, {
					written: queryState.data.written,
					rolledBack: false
				});
			}
		} else if (
			queryState.error !== null &&
			queryState.lastSource !== undefined
		) {
			// Trace les writes rollback dans l'history — utile pour l'audit
			// post-incident ("j'ai tenté ça, la tx a rollback"). Les erreurs
			// ordinaires (parse, table absente) ne sont PAS ajoutées :
			// l'history reste utile, pas polluée.
			const kind =
				queryState.error instanceof SnqlRuntimeError
					? classifyRuntimeError(queryState.error)
					: "ordinary";
			if (kind !== "ordinary") {
				persistence.addHistory(queryState.lastSource, {
					written: true,
					rolledBack: true
				});
			}
		}
	}, [
		queryState.lastRunAt,
		queryState.data,
		queryState.error,
		queryState.timingMs,
		queryState.lastSource,
		tabs,
		activeTabId,
		persistence
	]);

	const format = useCallback(() => {
		const src = tabs.activeTab.source;
		if (src.trim() === "") return;
		const formatted = formatSnql(src);
		if (formatted !== src) {
			tabs.updateSource(activeTabId, formatted);
		}
	}, [tabs, activeTabId]);

	// Autorun depuis ?autorun=1 — one-shot au mount.
	const autoranRef = useRef(false);
	// Autorun est un vecteur URL-partagée : un lien
	// `/query?source=remove+from+users&autorun=1` déclencherait wipe silencieux
	// à l'ouverture. On refuse l'auto-exec si la source contient un unfiltered
	// write OU un raw opaque. L'user peut toujours exec manuellement (⌘⏎) après
	// vérification. Banner permanent + strip `autorun=1` de l'URL pour ne pas
	// ré-armer au reload (defense in depth : le check reste actif même sans le
	// query param, mais on veut que la page revienne à un état sain).
	const [autorunRefused, setAutorunRefused] = useState(false);
	useEffect(() => {
		if (
			!initialAutorun ||
			autoranRef.current ||
			tabs.activeTab.source.trim() === ""
		) {
			return;
		}
		autoranRef.current = true;
		const src = tabs.activeTab.source.trim();
		let refused = false;
		try {
			refused = hasAnyUnfilteredWrite(parse(tokenize(src)));
		} catch {
			// Parse KO : source syntaxiquement invalide. On laisse l'autorun
			// tourner — le CLI renverra l'erreur, mais aucun risque de wipe
			// (parse KO = pas d'exec possible côté cœur). Le typing gate côté
			// execute() reste actif si l'user re-tape ensuite.
		}
		if (refused) {
			setAutorunRefused(true);
			// Strip `autorun=1` de l'URL via history.replaceState — pas de
			// dépendance TanStack Router (moins couplé, marche identique
			// route/node/popout). Le state React React `autorunRefused` est
			// la source de vérité pour l'affichage du banner.
			try {
				const url = new URL(window.location.href);
				if (url.searchParams.has("autorun")) {
					url.searchParams.delete("autorun");
					window.history.replaceState({}, "", url.toString());
				}
			} catch {
				// window.location peut être indisponible en test (jsdom) —
				// silencieux, le banner reste affiché quand même.
			}
			return;
		}
		execute();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialAutorun, tabs.activeTab.source]);

	// Hotkeys communs aux deux variants. Escape et mod+shift+K sont
	// laissés au parent (dépendent du contexte route vs node).
	useHotkeys(
		[
			["mod+shift+F", format, { preventDefault: true }],
			["mod+T", tabs.newTab, { preventDefault: true }],
			[
				"mod+W",
				() => tabs.closeTab(activeTabId),
				{ preventDefault: true }
			]
			// Mod-Shift-Enter (exec in tx) est routé via le CM keymap dans
			// SnqlEditor (voir onRunInTransaction prop). Le useHotkeys
			// Mantine ne capte pas les keydowns quand le focus est dans CM
			// content — CM les absorbe avant remontée document.
		],
		[]
	);

	// `onDetach` stubbed en mode node : la prop existe dans ConsoleHeader
	// mais le bouton est caché. On passe un no-op plutôt qu'undefined.
	const detachHandler = onDetach ?? (() => {});

	return (
		<div style={shellStyle}>
			<ConsoleHeader
				connectionName={connection?.name ?? "…"}
				teamSlug={teamSlug}
				connId={connId}
				isPopout={isPopout}
				canExecute={
					activeSource.trim() !== "" && connection !== undefined
				}
				canFormat={activeSource.trim() !== ""}
				isRunning={queryState.isPending}
				onExecute={execute}
				onFormat={format}
				onDetach={detachHandler}
				history={persistence.history}
				onHistorySelect={(source) =>
					tabs.updateSource(activeTabId, source)
				}
				onHistoryClear={persistence.clearHistory}
				tabs={tabs.state.tabs}
				activeTabId={activeTabId}
				onSelectTab={tabs.setActive}
				onCloseTab={tabs.closeTab}
				onNewTab={tabs.newTab}
				onRenameTab={tabs.renameTab}
				onReorderTabs={tabs.reorderTabs}
				variant={variant}
				extraLeftActions={extraLeftActions}
			/>

			<div ref={bodyRef} style={bodyStyle}>
				{/* Banner permanent affiché quand un autorun a été refusé
				    pour source unfiltered/raw — dismiss local via ×, ne
				    re-arme pas l'auto-exec. */}
				{autorunRefused ? (
					<AutorunRefusedBanner
						onDismiss={() => setAutorunRefused(false)}
					/>
				) : null}
				{/* Résultats masqués tant qu'aucune query n'a été lancée — évite
				    le "vide flou" au premier chargement, laisse l'éditeur
				    respirer tout seul. Apparaît dès qu'un run est pending / OK /
				    en erreur. */}
				<div
					style={{
						...editorWrapperStyle,
						...(hasRun
							? { height: editorHeight }
							: { flex: 1, minHeight: 0 })
					}}
				>
					<div style={editorFillStyle}>
						<SnqlEditor
							ref={editorRef}
							value={activeSource}
							onChange={(v) => tabs.updateSource(activeTabId, v)}
							onRun={execute}
							onRunInTransaction={executeInTransaction}
							schema={schemaWithSystem ?? null}
							placeholder="get <table> pick <fields>"
							errorSpans={errorSpans}
							liveDiagnostic={liveDiagnostic}
							rawStatementSpan={rawStatementSpan}
						/>
					</div>
				</div>
				{pending !== null ? (
					<WriteConfirmBar
						findings={pending}
						preview={previewResult}
						onConfirm={confirmExecute}
						onCancel={cancelPending}
					/>
				) : null}
				{hasRun ? (
					<>
						<div
							style={{
								...resizeHandleStyle,
								background: isDragging
									? "var(--sqlnest-accent-muted)"
									: "var(--sqlnest-border)"
							}}
							onPointerDown={startDrag}
							role="separator"
							aria-orientation="horizontal"
							aria-label="Redimensionner l'éditeur"
						/>
						<ConsoleResultsPanel
							result={queryState.data}
							error={queryState.error}
							isPending={queryState.isPending}
							timingMs={queryState.timingMs}
							onFocusSpan={onFocusSpan}
							engine={engine}
							lastSource={queryState.lastSource}
							schema={schemaWithSystem ?? undefined}
						/>
					</>
				) : null}
			</div>
		</div>
	);
}
