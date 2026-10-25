/** Largeur de chaque colonne d'un tableau de cellules. */
export function columnWidths(rows: readonly (readonly string[])[]): number[] {
	const widths: number[] = [];
	for (const cells of rows) {
		cells.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, cell.length);
		});
	}
	return widths;
}

/** Colonnes alignées ; une colonne vide sur toutes les lignes disparaît. */
export function alignCells(
	cells: readonly string[],
	widths: readonly number[]
): string {
	return cells
		.flatMap((cell, i) =>
			(widths[i] ?? 0) === 0
				? []
				: [i < cells.length - 1 ? cell.padEnd(widths[i] ?? 0) : cell]
		)
		.join("  ")
		.trimEnd();
}
