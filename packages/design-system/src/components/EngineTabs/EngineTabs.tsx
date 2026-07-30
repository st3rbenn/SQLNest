import { SegmentedControl } from "@mantine/core";

export type EngineValue = "postgres" | "mongodb";

export type EngineTabsProps = {
	value: EngineValue;
	onChange: (value: EngineValue) => void;
	disabled?: boolean;
};

const DATA = [
	{ value: "postgres", label: "PostgreSQL" },
	{ value: "mongodb", label: "MongoDB" },
];

export function EngineTabs({ value, onChange, disabled }: EngineTabsProps) {
	return (
		<SegmentedControl
			value={value}
			onChange={(v) => onChange(v as EngineValue)}
			data={DATA}
			color="brand"
			radius="sm"
			size="xs"
			{...(disabled === undefined ? {} : { disabled })}
		/>
	);
}
