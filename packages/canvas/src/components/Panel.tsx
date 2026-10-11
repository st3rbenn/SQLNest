import {
	type CSSProperties,
	forwardRef,
	type HTMLAttributes,
	type ReactNode
} from "react";
import { canvasClass } from "../constants";
import type { PanelPosition } from "../types";

export type PanelProps = HTMLAttributes<HTMLDivElement> & {
	position?: PanelPosition;
	children?: ReactNode;
	style?: CSSProperties;
};

/** Conteneur ancré à un coin ou un bord du canvas, au-dessus du viewport. */
export const Panel = forwardRef<HTMLDivElement, PanelProps>(
	({ position = "top-left", children, className, style, ...rest }, ref) => (
		<div
			className={[canvasClass.panel, className, ...position.split("-")]
				.filter(Boolean)
				.join(" ")}
			style={style}
			ref={ref}
			{...rest}
		>
			{children}
		</div>
	)
);
Panel.displayName = "Panel";
