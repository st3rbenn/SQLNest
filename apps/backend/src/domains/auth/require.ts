import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Type d'un `request.user` non-null — reprend l'augmentation posée dans
 * `src/types/fastify.d.ts`. On l'exporte pour narrower le type dans les
 * handlers qui utilisent le guard.
 */
export type AuthenticatedUser = NonNullable<FastifyRequest["user"]>;

/**
 * Type d'un `FastifyRequest` garanti authentifié — utile pour typer les
 * handlers qui viennent après `requireUser` dans la chaîne preHandler.
 */
export type AuthenticatedRequest = FastifyRequest & {
	user: AuthenticatedUser;
};

/**
 * Guard preHandler pour les routes protégées.
 *
 * ─── Usage recommandé (preHandler) ─────────────────────────────────────
 *   fastify.post(
 *     "/canvas",
 *     { preHandler: [requireUser] },
 *     async (request, reply) => {
 *       // request.user est garanti non-null ici (via l'assertion function
 *       // ci-dessous — cf. `assertAuthenticated`).
 *     }
 *   );
 *
 * ─── Contrat ───────────────────────────────────────────────────────────
 * Si `request.user` est null (aucune session valide populée par le hook
 * `04-session`), on rejoue une réponse `401 { message: "Non authentifié" }`
 * et on court-circuite la chaîne (Fastify voit `reply.sent === true` après
 * `reply.send()` dans un preHandler et n'appelle plus le handler).
 *
 * On NE THROW PAS : Fastify convertirait l'exception en 500 par défaut, ce
 * qui masquerait la vraie raison (401). Utiliser `reply.code(401).send()`
 * est le pattern idiomatique Fastify pour un short-circuit propre.
 *
 * Alternative si tu veux narrower le type dans le handler LUI-MÊME (au
 * lieu de faire confiance au preHandler) : utilise `assertAuthenticated`
 * ci-dessous — c'est une TypeScript assertion function qui throw et
 * garantit `request.user` non-null au compile time.
 */
export async function requireUser(
	request: FastifyRequest,
	reply: FastifyReply
): Promise<void> {
	if (request.user == null) {
		reply.code(401).send({ message: "Non authentifié" });
	}
}

/**
 * Assertion function TypeScript — usable à l'intérieur d'un handler pour
 * narrower le type de `request.user` de `... | null` à non-null.
 *
 * Throw une erreur avec `statusCode: 401` — Fastify la convertira en
 * réponse `401 { message, statusCode }` via son error handler par défaut.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────
 *   async function handler(request: FastifyRequest) {
 *     assertAuthenticated(request);
 *     // request.user est maintenant typé NonNullable<...>
 *     return { userId: request.user.id };
 *   }
 *
 * Généralement inutile si `requireUser` est déjà dans les preHandlers —
 * mais l'assertion garantit la sûreté typing même si un dev oublie le
 * preHandler.
 */
export function assertAuthenticated(
	request: FastifyRequest
): asserts request is AuthenticatedRequest {
	if (request.user == null) {
		const err = new Error("Non authentifié") as Error & {
			statusCode: number;
		};
		err.statusCode = 401;
		throw err;
	}
}

/**
 * Helper — retourne l'utilisateur courant OU null.
 *
 * Sucre syntaxique pour les handlers qui gèrent explicitement les deux
 * cas (ex: endpoint public qui personnalise si connecté). Retour typé
 * `AuthenticatedUser | null`.
 */
export function getCurrentUser(
	request: FastifyRequest
): AuthenticatedUser | null {
	return request.user;
}
