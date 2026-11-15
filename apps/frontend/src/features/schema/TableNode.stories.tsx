import { SchemaStoryCanvas } from "./SchemaStoryCanvas";
import { SAMPLE_POSTGRES } from "./schema-model";
import { TableNode } from "./TableNode";

export default {
	title: "App/Canvas/TableNode",
	component: TableNode,
	parameters: { layout: "fullscreen" }
};

export const Repos = {
	render: () => (
		<SchemaStoryCanvas
			schema={SAMPLE_POSTGRES}
			tables={["users"]}
			withEdges={false}
			height={360}
		/>
	)
};

/** La table cliquée est mise en avant, les autres estompées. */
export const FocusEtEstompe = {
	render: () => (
		<SchemaStoryCanvas
			schema={SAMPLE_POSTGRES}
			tables={["users", "orders"]}
			focused="users"
			dimmed={["orders"]}
			withEdges={false}
			height={420}
		/>
	)
};
