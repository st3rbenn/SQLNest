import { useState } from "react";
import type { Frame } from "./frames";
import { SchemaTree } from "./SchemaTree";
import { SAMPLE_POSTGRES } from "./schema-model";

export default {
	title: "App/Canvas/SchemaTree",
	component: SchemaTree
};

const FRAMES: readonly Frame[] = [
	{
		key: "commerce",
		label: "Commerce",
		hue: 30,
		collections: ["orders", "order_items"]
	}
];

function Demo({
	frames,
	search
}: {
	readonly frames: readonly Frame[];
	readonly search: string;
}) {
	const [focusId, setFocusId] = useState<string | null>(null);
	return (
		<div
			style={{
				width: 280,
				padding: "8px 0",
				background: "var(--sqlnest-surface)"
			}}
		>
			<SchemaTree
				schema={SAMPLE_POSTGRES}
				frames={frames}
				focusId={focusId}
				search={search}
				onSelect={setFocusId}
			/>
		</div>
	);
}

/** Tables rangées par préfixe de nom. */
export const ParPrefixe = { render: () => <Demo frames={[]} search="" /> };

/** Un frame regroupe ses tables en tête de l'arbre. */
export const AvecFrame = { render: () => <Demo frames={FRAMES} search="" /> };

export const Recherche = { render: () => <Demo frames={[]} search="order" /> };
