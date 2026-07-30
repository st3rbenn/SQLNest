import { TextInput, type TextInputProps } from "@mantine/core";

export type SearchInputProps = Omit<TextInputProps, "type" | "leftSection">;

const SearchIcon = () => (
	<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
		<title>Rechercher</title>
		<circle cx={11} cy={11} r={7} />
		<path d="M20 20l-3-3" />
	</svg>
);

export function SearchInput(props: SearchInputProps) {
	return (
		<TextInput
			type="search"
			size="sm"
			radius="sm"
			leftSection={<SearchIcon />}
			{...props}
		/>
	);
}
