/**
 * Point d'entrée unique du moteur canvas pour toute l'app (ADR-033).
 *
 * Transitoire : sert React Flow ou `@sqlnest/canvas` selon `?engine=rf|nest`
 * (mémorisé dans le navigateur, React Flow par défaut) pour comparer les deux
 * sur le même canvas. Une fois la parité atteinte, ce fichier disparaît et
 * les imports pointent directement sur `@sqlnest/canvas`.
 */
import * as nest from "@sqlnest/canvas";
import "@sqlnest/canvas/style.css";
import * as rf from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const ENGINE_KEY = "sqlnest.canvasEngine";

function readEngine(): "nest" | "rf" {
	if (typeof window === "undefined") return "rf";
	const fromUrl = new URLSearchParams(window.location.search).get("engine");
	if (fromUrl === "nest" || fromUrl === "rf") {
		try {
			window.localStorage.setItem(ENGINE_KEY, fromUrl);
		} catch {}
		return fromUrl;
	}
	try {
		return window.localStorage.getItem(ENGINE_KEY) === "nest" ? "nest" : "rf";
	} catch {
		return "rf";
	}
}

export const canvasEngine = readEngine();
const useNest = canvasEngine === "nest";

// Pas encore porté sur `@sqlnest/canvas` : neutralisé en mode nest.
const Nothing = () => null;

export const NestCanvas = (
	useNest ? nest.NestCanvas : rf.ReactFlow
) as typeof rf.ReactFlow;
export const NestCanvasProvider = (
	useNest ? nest.NestCanvasProvider : rf.ReactFlowProvider
) as typeof rf.ReactFlowProvider;
export const useNestCanvas = (
	useNest ? nest.useNestCanvas : rf.useReactFlow
) as typeof rf.useReactFlow;
export const useNestStore = (
	useNest ? nest.useNestStore : rf.useStore
) as typeof rf.useStore;
export const useViewport = (
	useNest ? nest.useViewport : rf.useViewport
) as typeof rf.useViewport;
export const useNodesState = (
	useNest ? nest.useNodesState : rf.useNodesState
) as typeof rf.useNodesState;
export const Background = (
	useNest ? nest.Background : rf.Background
) as typeof rf.Background;
export const Panel = (useNest ? nest.Panel : rf.Panel) as typeof rf.Panel;
export const Handle = (useNest ? nest.Handle : rf.Handle) as typeof rf.Handle;
export const NodeResizer = (
	useNest ? nest.NodeResizer : rf.NodeResizer
) as typeof rf.NodeResizer;
export const EdgeLabelRenderer = (
	useNest ? Nothing : rf.EdgeLabelRenderer
) as typeof rf.EdgeLabelRenderer;
export const useOnSelectionChange = (
	useNest ? nest.useOnSelectionChange : rf.useOnSelectionChange
) as typeof rf.useOnSelectionChange;

export type {
	Edge,
	EdgeProps,
	Node,
	NodeChange,
	NodeProps
} from "@xyflow/react";
export {
	getSmoothStepPath,
	MarkerType,
	Position,
	SelectionMode
} from "@xyflow/react";

/** Classes DOM du moteur lues par l'app (tween CSS, détection du pane). */
export const canvasClass = useNest
	? {
			viewport: nest.canvasClass.viewport,
			pane: nest.canvasClass.pane,
			edgePath: nest.canvasClass.edgePath
		}
	: {
			viewport: "react-flow__viewport",
			pane: "react-flow__pane",
			edgePath: "react-flow__edge-path"
		};
