import type { TableNodeType } from "../TableNode";

type Data = TableNodeType["data"];

export type TableFlags = {
	readonly dimmed: boolean;
	readonly focused: boolean;
	readonly hoverHighlight: boolean;
};

export type TableResizeHandler = (
	id: string,
	size: { width: number; height: number; x: number; y: number }
) => void;

/**
 * Habille les tables pour l'affichage (estompage, focus, survol, resize) en
 * rendant le même objet tant que rien ne change pour une table : le moteur
 * ne re-rend que les tables touchées. Une table seulement déplacée (drag,
 * frame qui l'emmène) garde aussi le même `data`, ce qui épargne son rendu.
 */
export function createTableDecorator(onResize: TableResizeHandler) {
	const datas = new WeakMap<Data, { flags: TableFlags; data: Data }>();
	const nodes = new WeakMap<TableNodeType, TableNodeType>();

	return (node: TableNodeType, flags: TableFlags): TableNodeType => {
		let entry = datas.get(node.data);
		if (
			entry === undefined ||
			entry.flags.dimmed !== flags.dimmed ||
			entry.flags.focused !== flags.focused ||
			entry.flags.hoverHighlight !== flags.hoverHighlight
		) {
			const id = node.id;
			entry = {
				flags,
				data: {
					...node.data,
					...flags,
					matched: false,
					onResizeEnd: (size) => onResize(id, size)
				}
			};
			datas.set(node.data, entry);
		}
		const cached = nodes.get(node);
		if (cached?.data === entry.data) return cached;
		const out = { ...node, data: entry.data };
		nodes.set(node, out);
		return out;
	};
}
