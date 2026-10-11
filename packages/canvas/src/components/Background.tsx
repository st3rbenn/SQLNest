import type { CSSProperties } from "react";
import { canvasClass } from "../constants";
import { shallow, useNestStore } from "../context";

export type BackgroundProps = {
	/** Écart entre deux points, en unités du flow. */
	gap?: number;
	/** Diamètre d'un point, en unités du flow. */
	size?: number;
	color?: string;
	bgColor?: string;
	className?: string;
	style?: CSSProperties;
};

/** Grille de points qui suit le pan et le zoom. */
export function Background({
	gap = 20,
	size = 1,
	color,
	bgColor,
	className,
	style
}: BackgroundProps) {
	const { transform, patternId } = useNestStore(
		(s) => ({
			transform: s.transform,
			patternId: `nest-pattern-${s.instanceId}`
		}),
		shallow
	);
	const [tx, ty, k] = transform;
	const scaledGap = gap * k || 1;
	const radius = (size * k) / 2;
	const offset = 1 + scaledGap / 2;
	return (
		<svg
			aria-hidden="true"
			className={[canvasClass.background, className].filter(Boolean).join(" ")}
			style={
				{
					...style,
					position: "absolute",
					width: "100%",
					height: "100%",
					top: 0,
					left: 0,
					"--nest-background-color-props": bgColor,
					"--nest-background-pattern-color-props": color
				} as CSSProperties
			}
		>
			<pattern
				id={patternId}
				x={tx % scaledGap}
				y={ty % scaledGap}
				width={scaledGap}
				height={scaledGap}
				patternUnits="userSpaceOnUse"
				patternTransform={`translate(-${offset},-${offset})`}
			>
				<circle
					cx={radius}
					cy={radius}
					r={radius}
					className={`${canvasClass.backgroundPattern} dots`}
				/>
			</pattern>
			<rect
				x="0"
				y="0"
				width="100%"
				height="100%"
				fill={`url(#${patternId})`}
			/>
		</svg>
	);
}
