import type { CSSProperties } from "react";

export type ColorDotSize = "sm" | "md" | "lg";

export interface ColorDotProps {
	/** Couleur de fond du dot (typiquement `colorFor(name).border`). */
	readonly color: string;
	/** Taille : `sm`=8px rond, `md`=10px rond, `lg`=12px carré arrondi 4px. */
	readonly size?: ColorDotSize;
	readonly "aria-label"?: string;
}

interface DotSpec {
	readonly px: number;
	readonly borderRadius: number | string;
}

const SPECS: Record<ColorDotSize, DotSpec> = {
	sm: { px: 8, borderRadius: "50%" },
	md: { px: 10, borderRadius: "50%" },
	lg: { px: 12, borderRadius: 4 }
};

/**
 * Petit indicateur coloré partagé — pastille ronde (sm/md) ou carré arrondi
 * (lg). Utilisé pour marquer une entité par sa couleur schéma (tables dans
 * l'arbre, titres, RelationLink…). Rendu comme un `<span>` inline-block :
 * s'insère au fil du flux, `flexShrink: 0` pour ne pas se laisser écraser
 * dans un container flex.
 */
export function ColorDot({
	color,
	size = "sm",
	"aria-label": ariaLabel
}: ColorDotProps) {
	const spec = SPECS[size];
	const style: CSSProperties = {
		display: "inline-block",
		width: spec.px,
		height: spec.px,
		borderRadius: spec.borderRadius,
		background: color,
		flexShrink: 0
	};
	return <span style={style} aria-label={ariaLabel} />;
}
