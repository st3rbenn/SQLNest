import { InteractiveEdge } from "./InteractiveEdge";
import { SchemaStoryCanvas } from "./SchemaStoryCanvas";
import { SAMPLE_POSTGRES } from "./schema-model";

export default {
	title: "App/Canvas/InteractiveEdge",
	component: InteractiveEdge,
	parameters: { layout: "fullscreen" }
};

/** Clés étrangères déclarées : trait plein, couleur d'accent. */
export const RelationsDeclarees = {
	render: () => <SchemaStoryCanvas schema={SAMPLE_POSTGRES} />
};
