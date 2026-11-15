import { FrameNode } from "./FrameNode";
import type { Frame } from "./frames";
import { SchemaStoryCanvas } from "./SchemaStoryCanvas";
import { SAMPLE_POSTGRES } from "./schema-model";

export default {
	title: "App/Canvas/FrameNode",
	component: FrameNode,
	parameters: { layout: "fullscreen" }
};

const FRAMES: readonly Frame[] = [
	{
		key: "commerce",
		label: "Commerce",
		hue: 30,
		collections: ["users", "orders"],
		rect: { x: -40, y: -70, width: 700, height: 330 }
	}
];

/** Un frame entoure ses tables ; son badge porte son nom. */
export const AutourDeDeuxTables = {
	render: () => (
		<SchemaStoryCanvas
			schema={SAMPLE_POSTGRES}
			tables={["users", "orders"]}
			frames={FRAMES}
			height={480}
		/>
	)
};
