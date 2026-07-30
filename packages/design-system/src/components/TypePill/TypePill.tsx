import { Text, type TextProps } from "@mantine/core";

export type TypePillProps = {
	type: string;
	nullable?: boolean;
} & Omit<TextProps, "children" | "ff" | "size" | "c">;

export function TypePill({ type, nullable, ...rest }: TypePillProps) {
	return (
		<Text ff="monospace" size="xs" c="slate.4" {...rest}>
			{nullable ? `${type} ?` : type}
		</Text>
	);
}
