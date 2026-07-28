import { type CSSProperties, useId } from "react";
import type {
	Collection,
	Relation,
	SchemaModel,
	SnqlType
} from "./schema-model";

const NON_ALNUM = /[^a-z0-9]/gi;

const CARD_W = 264;
const HEADER_H = 48;
const ROW_H = 30;
const PAD_BOTTOM = 12;
const GAP_X = 96;
const GAP_Y = 60;
const MARGIN = 28;

const TYPE_COLOR: Record<SnqlType, string> = {
	string: "#2563eb",
	int: "#7c3aed",
	bigint: "#7c3aed",
	float: "#7c3aed",
	decimal: "#7c3aed",
	bool: "#059669",
	date: "#d97706",
	json: "#db2777",
	array: "#db2777",
	uuid: "#0891b2",
	unknown: "#64748b"
};

interface Box {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

function cardHeight(collection: Collection): number {
	return HEADER_H + collection.fields.length * ROW_H + PAD_BOTTOM;
}

function columnCount(total: number): number {
	if (total <= 2) {
		return Math.max(total, 1);
	}
	return total <= 6 ? 2 : 3;
}

function layout(collections: readonly Collection[]): {
	boxes: Map<string, Box>;
	width: number;
	height: number;
} {
	const cols = columnCount(collections.length);
	const boxes = new Map<string, Box>();
	let rowTop = MARGIN;

	for (let start = 0; start < collections.length; start += cols) {
		const row = collections.slice(start, start + cols);
		let rowMaxH = 0;
		row.forEach((collection, i) => {
			const h = cardHeight(collection);
			boxes.set(collection.name, {
				x: MARGIN + i * (CARD_W + GAP_X),
				y: rowTop,
				w: CARD_W,
				h
			});
			rowMaxH = Math.max(rowMaxH, h);
		});
		rowTop += rowMaxH + GAP_Y;
	}

	const width = MARGIN * 2 + cols * CARD_W + (cols - 1) * GAP_X;
	const height = rowTop - GAP_Y + MARGIN;
	return { boxes, width, height };
}

interface Anchor {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
	readonly horizontal: boolean;
}

function anchor(from: Box, to: Box): Anchor {
	const fromCx = from.x + from.w / 2;
	const toCx = to.x + to.w / 2;
	if (Math.abs(toCx - fromCx) > from.w / 2) {
		return toCx > fromCx
			? {
					x1: from.x + from.w,
					y1: from.y + from.h / 2,
					x2: to.x,
					y2: to.y + to.h / 2,
					horizontal: true
				}
			: {
					x1: from.x,
					y1: from.y + from.h / 2,
					x2: to.x + to.w,
					y2: to.y + to.h / 2,
					horizontal: true
				};
	}
	return to.y > from.y
		? { x1: fromCx, y1: from.y + from.h, x2: toCx, y2: to.y, horizontal: false }
		: { x1: fromCx, y1: from.y, x2: toCx, y2: to.y + to.h, horizontal: false };
}

function edgePath(a: Anchor): string {
	if (a.horizontal) {
		const c = Math.max(48, Math.abs(a.x2 - a.x1) / 2);
		const s = a.x2 > a.x1 ? c : -c;
		return `M ${a.x1} ${a.y1} C ${a.x1 + s} ${a.y1}, ${a.x2 - s} ${a.y2}, ${a.x2} ${a.y2}`;
	}
	const c = Math.max(48, Math.abs(a.y2 - a.y1) / 2);
	const s = a.y2 > a.y1 ? c : -c;
	return `M ${a.x1} ${a.y1} C ${a.x1} ${a.y1 + s}, ${a.x2} ${a.y2 - s}, ${a.x2} ${a.y2}`;
}

const STYLES = `
.sv-root { position: relative; font-family: ui-sans-serif, system-ui, sans-serif; }
.sv-card { position: absolute; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
	box-shadow: 0 4px 14px rgba(15,23,42,.08); overflow: hidden; }
.sv-card__head { height: ${HEADER_H}px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
	border-bottom: 1px solid #eef2f7; }
.sv-card__name { font-weight: 650; font-size: 14px; color: #0f172a; }
.sv-src { margin-left: auto; font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
	padding: 2px 7px; border-radius: 999px; }
.sv-src--declared { color: #1d4ed8; background: #dbeafe; }
.sv-src--inferred { color: #b45309; background: #fef3c7; }
.sv-row { height: ${ROW_H}px; display: flex; align-items: center; gap: 8px; padding: 0 14px; font-size: 13px; }
.sv-row + .sv-row { border-top: 1px solid #f5f7fa; }
.sv-pk { font-size: 9px; font-weight: 800; color: #b45309; border: 1px solid #fcd34d; background: #fffbeb;
	border-radius: 4px; padding: 0 3px; line-height: 14px; }
.sv-fname { color: #1e293b; }
.sv-fname--null { color: #64748b; }
.sv-null { color: #94a3b8; font-size: 12px; }
.sv-type { margin-left: auto; font-size: 11px; font-weight: 650; font-family: ui-monospace, monospace; }
.sv-conf { font-size: 10px; color: #94a3b8; width: 30px; text-align: right; }
.sv-legend { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; margin: 4px 0 14px;
	font-size: 12px; color: #475569; }
.sv-legend b { color: #0f172a; }
.sv-swatch { display: inline-block; width: 22px; height: 0; border-top-width: 2px; vertical-align: middle; margin-right: 6px; }
`;

function fieldRow(
	collection: Collection,
	name: string,
	type: SnqlType,
	nullable: boolean,
	confidence: number | undefined
) {
	const isPk = collection.primaryKey?.includes(name) ?? false;
	return (
		<div className="sv-row" key={name}>
			{isPk ? <span className="sv-pk">PK</span> : null}
			<span className={nullable ? "sv-fname sv-fname--null" : "sv-fname"}>
				{name}
			</span>
			{nullable ? <span className="sv-null">?</span> : null}
			<span className="sv-type" style={{ color: TYPE_COLOR[type] }}>
				{type}
			</span>
			{confidence !== undefined && confidence < 1 ? (
				<span className="sv-conf">{Math.round(confidence * 100)}%</span>
			) : null}
		</div>
	);
}

function CollectionCard({
	collection,
	box
}: {
	collection: Collection;
	box: Box;
}) {
	const style: CSSProperties = { left: box.x, top: box.y, width: box.w };
	return (
		<div className="sv-card" style={style}>
			<div className="sv-card__head">
				<span className="sv-card__name">{collection.name}</span>
				<span className={`sv-src sv-src--${collection.source}`}>
					{collection.source === "declared" ? "déclaré" : "inféré"}
				</span>
			</div>
			{collection.fields.map((field) =>
				fieldRow(
					collection,
					field.name,
					field.type,
					field.nullable,
					field.confidence
				)
			)}
		</div>
	);
}

function RelationEdge({
	relation,
	boxes,
	arrowId
}: {
	relation: Relation;
	boxes: Map<string, Box>;
	arrowId: string;
}) {
	const from = boxes.get(relation.from.collection);
	const to = boxes.get(relation.to.collection);
	if (from === undefined || to === undefined) {
		return null;
	}
	const path = edgePath(anchor(from, to));
	const inferred = relation.origin !== "foreign-key";
	return (
		<path
			d={path}
			fill="none"
			stroke={inferred ? "#d97706" : "#3b82f6"}
			strokeWidth={2}
			strokeDasharray={inferred ? "6 5" : undefined}
			strokeOpacity={inferred ? Math.max(0.4, relation.confidence) : 0.9}
			markerEnd={`url(#${arrowId})`}
		/>
	);
}

export function SchemaVisualizer({ schema }: { schema: SchemaModel }) {
	const { boxes, width, height } = layout(schema.collections);
	const arrowId = `sv-arrow-${useId().replace(NON_ALNUM, "")}`;
	return (
		<div>
			<style>{STYLES}</style>
			<div className="sv-legend">
				<span>
					<b>{schema.collections.length}</b> collections ·{" "}
					<b>{schema.relations.length}</b> relations · moteur{" "}
					<b>{schema.engine}</b>
				</span>
				<span>
					<span
						className="sv-swatch"
						style={{ borderTopStyle: "solid", borderTopColor: "#3b82f6" }}
					/>
					clé étrangère
				</span>
				<span>
					<span
						className="sv-swatch"
						style={{ borderTopStyle: "dashed", borderTopColor: "#d97706" }}
					/>
					inférée (heuristique)
				</span>
			</div>
			<div
				className="sv-root"
				style={{ width, height, minWidth: width, margin: "0 auto" }}
			>
				<svg
					width={width}
					height={height}
					style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
					role="img"
					aria-label={`Diagramme du schéma ${schema.engine}`}
				>
					<defs>
						<marker
							id={arrowId}
							viewBox="0 0 10 10"
							refX="9"
							refY="5"
							markerWidth="7"
							markerHeight="7"
							orient="auto-start-reverse"
						>
							<path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
						</marker>
					</defs>
					{schema.relations.map((relation, i) => (
						<RelationEdge
							relation={relation}
							boxes={boxes}
							arrowId={arrowId}
							key={`${relation.from.collection}.${relation.from.fields.join(",")}->${relation.to.collection}-${i}`}
						/>
					))}
				</svg>
				{schema.collections.map((collection) => {
					const box = boxes.get(collection.name);
					return box === undefined ? null : (
						<CollectionCard
							collection={collection}
							box={box}
							key={collection.name}
						/>
					);
				})}
			</div>
		</div>
	);
}
