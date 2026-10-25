export class AddConnectionError extends Error {
	readonly kind: "cancelled" | "invalid-input" | "unreachable";
	constructor(kind: AddConnectionError["kind"], message: string) {
		super(message);
		this.name = "AddConnectionError";
		this.kind = kind;
	}
}

export function unrecognizedConnection(): AddConnectionError {
	return new AddConnectionError(
		"invalid-input",
		"Chaîne de connexion non reconnue (attendu : URL postgres:// / mongodb:// / mssql://, JDBC, ADO.NET ou libpq)"
	);
}

/**
 * Message d'un échec de connexion, cause du pilote comprise. Une
 * `AggregateError` (une tentative IPv6 et une IPv4) a un message vide : ses
 * erreurs internes portent la cause.
 */
export function describeFailure(err: unknown): string {
	const message = (err as Error)?.message ?? String(err);
	const cause = (err as { cause?: unknown })?.cause;
	if (!(cause instanceof Error)) return message;
	const inner = (cause as { errors?: unknown }).errors;
	const causeMessage =
		cause.message !== ""
			? cause.message
			: Array.isArray(inner)
				? [
						...new Set(inner.map((e) => (e as Error)?.message ?? String(e)))
					].join(", ")
				: "";
	return causeMessage !== "" && !message.includes(causeMessage)
		? `${message} — ${causeMessage}`
		: message;
}
