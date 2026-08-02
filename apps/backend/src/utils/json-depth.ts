const MAX_DEPTH = 10;

export function jsonDepthExceeds(
	value: unknown,
	limit: number = MAX_DEPTH,
	current: number = 0
): boolean {
	if (current > limit) return true;
	if (value === null || typeof value !== "object") return false;

	if (Array.isArray(value)) {
		for (const item of value) {
			if (jsonDepthExceeds(item, limit, current + 1)) return true;
		}
		return false;
	}

	for (const key of Object.keys(value as Record<string, unknown>)) {
		if (
			jsonDepthExceeds(
				(value as Record<string, unknown>)[key],
				limit,
				current + 1
			)
		)
			return true;
	}
	return false;
}
