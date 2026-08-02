import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi
} from "vitest";
import type { Frame } from "../frames";
import type { AnchorMap } from "../useEdgeAnchors";
import type { PositionsMap } from "../useTablePositions";
import type { SizesMap } from "../useTableSizes";
import {
	CANVAS_SYNC_DEBOUNCE_MS,
	type UseCanvasSyncOptions,
	useCanvasSync
} from "./useCanvasSync";

// `useCurrentUser` mocké au niveau module : par défaut on est loggé. Certains
// tests plus bas overrident vers `null` via `mockReturnValue` pour valider
// le no-op anonyme. On tape ça `any` — la vraie forme est un `QueryResult`
// riche dont on n'exerce que `.data.user`.
vi.mock("../../auth/sessionQuery", () => ({
	useCurrentUser: vi.fn(() => ({
		data: { user: { id: "u1", email: "u@x", name: "u" } }
	}))
}));

// ─── Setup shared ────────────────────────────────────────────────────────
// Le stub window.CONTEXT est posé par `src/test-setup.ts` — ici on lui donne
// une base URL propre pour ne pas fabriquer des `undefined/canvas-state`.
window.CONTEXT = { apiBaseUrl: "http://api.test" };

function makeWrapper() {
	// staleTime 0 + retry:false → chaque render fetch au 1er coup, sans
	// backoff. gcTime 0 = pas de cache inter-tests. Isolant strict.
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, staleTime: 0 }
		}
	});
	return function Wrapper({ children }: { readonly children: ReactNode }) {
		return createElement(
			QueryClientProvider,
			{ client } as never,
			children as never
		);
	};
}

/**
 * Fabrique un ensemble d'opts complet pour `useCanvasSync`. Les 4 replaceAll
 * sont des `vi.fn` : les tests inspectent leur nombre d'appels et leurs
 * arguments. `signature` a une forme conforme au regex backend
 * `^[a-z]+:[a-zA-Z0-9_,.-]+$`.
 */
function makeOpts(
	overrides: Partial<UseCanvasSyncOptions> = {}
): UseCanvasSyncOptions {
	return {
		signature: "postgres:orders,users",
		positions: {} as PositionsMap,
		sizes: {} as SizesMap,
		frames: [] as readonly Frame[],
		hidden: new Set<string>(),
		edgeAnchors: {} as AnchorMap,
		replaceAll: {
			positions: vi.fn(),
			sizes: vi.fn(),
			frames: vi.fn(),
			hidden: vi.fn(),
			edgeAnchors: vi.fn()
		},
		...overrides
	};
}

/** Réponse fetch minimale (`ok`, `status`, `json`). */
function mockResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	} as unknown as Response;
}

let fetchMock: Mock;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe("useCanvasSync", () => {
	it("mount + 200 → replaceAll appelés avec les données serveur", async () => {
		const payload = {
			positions: { users: { x: 10, y: 20 } },
			sizes: { users: { width: 250, height: 180 } },
			frames: [
				{
					key: "f1",
					label: "F1",
					hue: 210,
					collections: ["users"]
				}
			],
			hidden: ["orders"]
		};
		fetchMock.mockResolvedValueOnce(
			mockResponse(200, { payload, updatedAt: "2026-01-01T00:00:00.000Z" })
		);
		const opts = makeOpts();

		renderHook(() => useCanvasSync(opts), { wrapper: makeWrapper() });

		await waitFor(() => {
			expect(opts.replaceAll.positions).toHaveBeenCalledTimes(1);
		});
		expect(opts.replaceAll.positions).toHaveBeenCalledWith({
			users: { x: 10, y: 20 }
		});
		expect(opts.replaceAll.sizes).toHaveBeenCalledWith({
			users: { width: 250, height: 180 }
		});
		expect(opts.replaceAll.frames).toHaveBeenCalledWith([
			{
				key: "f1",
				label: "F1",
				hue: 210,
				collections: ["users"]
			}
		]);
		expect(opts.replaceAll.hidden).toHaveBeenCalledWith(new Set(["orders"]));
	});

	it("mount + 404 → replaceAll pas appelés (état local préservé)", async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse(404, { message: "not found" })
		);
		const opts = makeOpts();

		renderHook(() => useCanvasSync(opts), { wrapper: makeWrapper() });

		// Attends que la query settle (isPending devient false). On observe
		// via un waitFor sur le fetch mock — la query a démarré = la queryFn
		// est appelée, et la promesse resolve immédiatement.
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		// Laisse tourner les microtasks pour que l'effet d'hydratation fire
		// après le settlement de la query.
		await new Promise((r) => setTimeout(r, 0));

		expect(opts.replaceAll.positions).not.toHaveBeenCalled();
		expect(opts.replaceAll.sizes).not.toHaveBeenCalled();
		expect(opts.replaceAll.frames).not.toHaveBeenCalled();
		expect(opts.replaceAll.hidden).not.toHaveBeenCalled();
	});

	it("mount + erreur réseau → replaceAll pas appelés (mode offline)", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		const opts = makeOpts();

		const { result } = renderHook(() => useCanvasSync(opts), {
			wrapper: makeWrapper()
		});

		await waitFor(() => {
			expect(result.current.syncStatus).toBe("offline");
		});

		expect(opts.replaceAll.positions).not.toHaveBeenCalled();
		expect(opts.replaceAll.sizes).not.toHaveBeenCalled();
		expect(opts.replaceAll.frames).not.toHaveBeenCalled();
		expect(opts.replaceAll.hidden).not.toHaveBeenCalled();
	});

	it("state change → debounce 2 s → putCanvasState appelé une fois", async () => {
		// GET initial : 404 (état local adopté comme baseline).
		fetchMock.mockResolvedValueOnce(mockResponse(404, {}));
		// PUT retour : 200 avec updatedAt.
		fetchMock.mockResolvedValueOnce(
			mockResponse(200, { updatedAt: "2026-01-01T00:00:01.000Z" })
		);

		const initialOpts = makeOpts();
		const { rerender, result } = renderHook(
			(props: UseCanvasSyncOptions) => useCanvasSync(props),
			{ wrapper: makeWrapper(), initialProps: initialOpts }
		);

		// Attends l'hydratation (settle 404).
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		await new Promise((r) => setTimeout(r, 0));

		// Prend le contrôle du temps AVANT la mutation d'état, sinon le
		// setTimeout du hook part sur le vrai timer et on rate le rendez-vous.
		vi.useFakeTimers();

		// Nouvel opts avec position mutée + réutilise les mêmes replaceAll.
		const nextOpts: UseCanvasSyncOptions = {
			...initialOpts,
			positions: { users: { x: 100, y: 200 } }
		};
		rerender(nextOpts);

		// Le timer est armé. Un tick de 1999 ms ne doit rien déclencher.
		await act(async () => {
			vi.advanceTimersByTime(CANVAS_SYNC_DEBOUNCE_MS - 1);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Le 1 ms final déclenche le push.
		await act(async () => {
			vi.advanceTimersByTime(1);
		});
		vi.useRealTimers();

		// Le PUT part avec le body attendu.
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
		const putCall = fetchMock.mock.calls[1];
		expect(putCall?.[0]).toBe("http://api.test/api/canvas-state");
		expect(putCall?.[1]?.method).toBe("PUT");
		const body = JSON.parse((putCall?.[1]?.body as string) ?? "{}") as {
			readonly signature: string;
			readonly payload: {
				readonly positions: Record<
					string,
					{ readonly x: number; readonly y: number }
				>;
			};
		};
		expect(body.signature).toBe("postgres:orders,users");
		expect(body.payload.positions).toEqual({ users: { x: 100, y: 200 } });

		await waitFor(() => {
			expect(result.current.lastSavedAt).toBe("2026-01-01T00:00:01.000Z");
		});
	});

	it("deux state changes rapprochés → un seul putCanvasState (debounce)", async () => {
		fetchMock.mockResolvedValueOnce(mockResponse(404, {}));
		fetchMock.mockResolvedValueOnce(
			mockResponse(200, { updatedAt: "2026-01-01T00:00:02.000Z" })
		);

		const initialOpts = makeOpts();
		const { rerender } = renderHook(
			(props: UseCanvasSyncOptions) => useCanvasSync(props),
			{ wrapper: makeWrapper(), initialProps: initialOpts }
		);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		await new Promise((r) => setTimeout(r, 0));

		vi.useFakeTimers();

		// Change 1 → programme un timeout à t+2000.
		rerender({
			...initialOpts,
			positions: { users: { x: 10, y: 10 } }
		});
		// Avance de 1000 ms — pas encore l'échéance.
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Change 2 (avant les 2 s) → reset du timer, nouvelle échéance à t+3000.
		rerender({
			...initialOpts,
			positions: { users: { x: 20, y: 20 } }
		});
		// Avance de 1500 ms (total 2500 depuis le change 1, mais seulement
		// 1500 depuis le change 2 → toujours pas fire).
		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Avance jusqu'à l'échéance depuis change 2.
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		vi.useRealTimers();

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
		// Le body porte la valeur FINALE (change 2), pas la valeur intermédiaire.
		const putBody = JSON.parse(
			(fetchMock.mock.calls[1]?.[1]?.body as string) ?? "{}"
		) as {
			readonly payload: {
				readonly positions: Record<
					string,
					{ readonly x: number; readonly y: number }
				>;
			};
		};
		expect(putBody.payload.positions).toEqual({ users: { x: 20, y: 20 } });
	});

	it("unmount pendant le debounce → flush immédiat via fetch keepalive", async () => {
		fetchMock.mockResolvedValueOnce(mockResponse(404, {}));
		// Le flush post-unmount envoie un PUT — on répond 200 pour rester
		// propre même si le résultat n'est pas awaité.
		fetchMock.mockResolvedValueOnce(
			mockResponse(200, { updatedAt: "2026-01-01T00:00:03.000Z" })
		);

		const initialOpts = makeOpts();
		const { rerender, unmount } = renderHook(
			(props: UseCanvasSyncOptions) => useCanvasSync(props),
			{ wrapper: makeWrapper(), initialProps: initialOpts }
		);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		await new Promise((r) => setTimeout(r, 0));

		// Change → arme le debounce.
		rerender({
			...initialOpts,
			positions: { users: { x: 42, y: 42 } }
		});
		// Laisse React commit l'effet debounce (setTimeout enregistré).
		await new Promise((r) => setTimeout(r, 0));

		// Unmount → devrait flush immédiatement, sans attendre les 2 s.
		unmount();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const flushCall = fetchMock.mock.calls[1];
		expect(flushCall?.[0]).toBe("http://api.test/api/canvas-state");
		expect(flushCall?.[1]?.method).toBe("PUT");
		expect(flushCall?.[1]?.keepalive).toBe(true);
		const flushBody = JSON.parse((flushCall?.[1]?.body as string) ?? "{}") as {
			readonly payload: {
				readonly positions: Record<
					string,
					{ readonly x: number; readonly y: number }
				>;
			};
		};
		expect(flushBody.payload.positions).toEqual({ users: { x: 42, y: 42 } });
	});

	// ─── Race hydratation ↔ push (H1) ─────────────────────────────────
	it("rerender pendant query.isFetching → gestes user préservés (replaceAll pas appelé si divergence détectée)", async () => {
		// Contrôle manuel du resolve du fetch : on rend l'user actif AVANT
		// la réponse serveur pour simuler « geste user pendant le GET ».
		let resolveFetch: ((v: Response) => void) | undefined;
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				})
		);

		const initialOpts = makeOpts();
		const { rerender } = renderHook(
			(props: UseCanvasSyncOptions) => useCanvasSync(props),
			{ wrapper: makeWrapper(), initialProps: initialOpts }
		);

		// Laisse RQ démarrer le queryFn (fetch pending).
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		// Geste user pendant le fetch : la position change AVANT que le
		// serveur ne réponde.
		rerender({
			...initialOpts,
			positions: { users: { x: 999, y: 999 } }
		});
		await new Promise((r) => setTimeout(r, 0));

		// Le serveur répond MAINTENANT avec un payload différent.
		const serverPayload = {
			positions: { users: { x: 10, y: 20 } },
			sizes: {},
			frames: [],
			hidden: []
		};
		if (!resolveFetch) throw new Error("resolveFetch not captured");
		resolveFetch(
			mockResponse(200, {
				payload: serverPayload,
				updatedAt: "2026-01-01T00:00:00.000Z"
			})
		);

		await new Promise((r) => setTimeout(r, 0));

		// Divergence détectée → replaceAll NE DOIT PAS écraser les gestes
		// user. Aucun des 4 replaceAll n'est appelé.
		expect(initialOpts.replaceAll.positions).not.toHaveBeenCalled();
		expect(initialOpts.replaceAll.sizes).not.toHaveBeenCalled();
		expect(initialOpts.replaceAll.frames).not.toHaveBeenCalled();
		expect(initialOpts.replaceAll.hidden).not.toHaveBeenCalled();
	});

	// ─── Baseline vide sur 404 (H2) ───────────────────────────────────
	// Vérifie qu'après un 404, la baseline est le payload VIDE — pas le
	// currentSerialized au moment du 404. Preuve : un state local non-vide
	// AU MOMENT du 404 (typique repli localStorage) déclenche un PUT sans
	// aucune action user supplémentaire après hydratation.
	it("404 hydration → baseline vide → premier push part avec le state local (non-vide)", async () => {
		fetchMock.mockResolvedValueOnce(mockResponse(404, {}));
		fetchMock.mockResolvedValueOnce(
			mockResponse(200, { updatedAt: "2026-01-01T00:00:10.000Z" })
		);

		// State local NON-VIDE dès le mount (repli localStorage typique).
		const opts = makeOpts({
			positions: { users: { x: 5, y: 5 } }
		});

		renderHook(() => useCanvasSync(opts), { wrapper: makeWrapper() });

		// Le PUT arrive après (a) le 404 settle, (b) hydration → baseline vide,
		// (c) push effect détecte divergence, (d) débounce 2 s réel. On attend
		// donc jusqu'à 3 s en real timers — les fake timers introduisent des
		// races avec les promise chains internes de RQ / React.
		await waitFor(
			() => {
				expect(fetchMock).toHaveBeenCalledTimes(2);
			},
			{ timeout: 3500 }
		);
		const putCall = fetchMock.mock.calls[1];
		expect(putCall?.[1]?.method).toBe("PUT");
		const body = JSON.parse((putCall?.[1]?.body as string) ?? "{}") as {
			readonly payload: {
				readonly positions: Record<
					string,
					{ readonly x: number; readonly y: number }
				>;
			};
		};
		expect(body.payload.positions).toEqual({ users: { x: 5, y: 5 } });
	});

	// ─── Capture signature au moment de l'armement (MED) ──────────────
	it("changement de signature pendant debounce → PUT part avec l'ancienne signature + ancien payload", async () => {
		// Mock URL-based : GET renvoie 404, PUT renvoie 200. Ordre de fire
		// entre GET nouvelle-sig et PUT ancienne-sig indéterministe → on
		// route par méthode/query pour éviter les race d'ordre.
		fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
			if ((init?.method ?? "GET") === "GET") {
				return Promise.resolve(mockResponse(404, {}));
			}
			return Promise.resolve(
				mockResponse(200, { updatedAt: "2026-01-01T00:00:20.000Z" })
			);
		});

		const initialOpts = makeOpts({ signature: "postgres:orders,users" });
		const { rerender } = renderHook(
			(props: UseCanvasSyncOptions) => useCanvasSync(props),
			{ wrapper: makeWrapper(), initialProps: initialOpts }
		);

		// GET initial orders,users settle → hydraté avec baseline vide.
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		await new Promise((r) => setTimeout(r, 0));

		// Change position → arme un débounce pour la signature ORIGINALE.
		// On n'attend PAS l'expiration du débounce (2 s) : l'effet
		// signature-change ci-dessous flush immédiatement le pending.
		rerender({
			...initialOpts,
			positions: { users: { x: 77, y: 77 } }
		});
		// Laisse React commit l'effet debounce (setTimeout armé + pendingPushRef).
		await new Promise((r) => setTimeout(r, 0));

		// Change de schéma (nouvelle signature) AVANT que le débounce ne fire.
		// L'effet signature-change doit flush le pending push IMMÉDIATEMENT
		// avec l'ANCIENNE signature (celle capturée à l'armement), puis reset
		// l'état pour la nouvelle sig.
		rerender({
			...initialOpts,
			signature: "postgres:products,users",
			positions: { users: { x: 77, y: 77 } }
		});

		// Le PUT part avec l'ANCIENNE signature.
		await waitFor(() => {
			const putCall = fetchMock.mock.calls.find(
				(c) => (c[1] as { method?: string } | undefined)?.method === "PUT"
			);
			expect(putCall).toBeDefined();
		});
		const putCall = fetchMock.mock.calls.find(
			(c) => (c[1] as { method?: string } | undefined)?.method === "PUT"
		);
		const putBody = JSON.parse(
			((putCall?.[1] as { body?: string }).body as string) ?? "{}"
		) as {
			readonly signature: string;
			readonly payload: {
				readonly positions: Record<
					string,
					{ readonly x: number; readonly y: number }
				>;
			};
		};
		expect(putBody.signature).toBe("postgres:orders,users");
		expect(putBody.payload.positions).toEqual({ users: { x: 77, y: 77 } });
	});

	// ─── Cleanup timer + pending post-hydration (H3, défensif) ────────
	it("hydration success pose baseline server et n'émet aucun PUT spurious", async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse(200, {
				payload: {
					positions: { users: { x: 50, y: 60 } },
					sizes: {},
					frames: [],
					hidden: []
				},
				updatedAt: "2026-01-01T00:00:30.000Z"
			})
		);

		const opts = makeOpts();
		renderHook(() => useCanvasSync(opts), { wrapper: makeWrapper() });

		// Hydration settle : replaceAll appelés, baseline = payload serveur.
		await waitFor(() => {
			expect(opts.replaceAll.positions).toHaveBeenCalled();
		});

		// Avance largement au-delà de la fenêtre de débounce : si un timer
		// stale avait été armé pendant le fetch et pas cleanupé, un PUT
		// serait parti. On vérifie qu'AUCUN PUT n'est émis — seul le GET
		// initial doit avoir été appelé.
		vi.useFakeTimers();
		await act(async () => {
			vi.advanceTimersByTime(CANVAS_SYNC_DEBOUNCE_MS * 2);
		});
		vi.useRealTimers();

		const putCalls = fetchMock.mock.calls.filter(
			(c) => (c[1] as { method?: string } | undefined)?.method === "PUT"
		);
		expect(putCalls.length).toBe(0);
	});
});
