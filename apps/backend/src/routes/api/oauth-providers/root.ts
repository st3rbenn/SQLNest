import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";

/**
 * Réponse : liste des providers OAuth **configurés côté serveur** (env
 * vars `{GOOGLE,GITHUB}_CLIENT_{ID,SECRET}` non vides). Sans ça, le
 * frontend rend les boutons Google/GitHub inconditionnellement et un
 * user clique dans le vide (le backend renvoie une erreur BA masquée
 * par le flow `window.location`).
 *
 * Public (pas de `requireUser`) : le frontend doit pouvoir décider quels
 * boutons rendre sur `/login` et `/signup` **avant** que l'user ait un
 * cookie. Aucune donnée sensible n'est exposée (juste des flags booléens).
 */
const OauthProvidersResponse = z.object({
	google: z.boolean(),
	github: z.boolean()
});

z.globalRegistry.add(OauthProvidersResponse, { id: "OauthProvidersResponse" });

export default function oauthProvidersRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	instance.get(
		"",
		{
			schema: { response: { 200: OauthProvidersResponse } }
		},
		async () => ({
			google: Boolean(
				process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
			),
			github: Boolean(
				process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
			)
		})
	);
}
