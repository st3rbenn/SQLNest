/**
 * `createApiToken` — génère un token clair, INSERT hash+prefix, retourne
 * l'entité + le clair one-shot.
 *
 * Le clair est renvoyé UNE fois au caller (la route). Il ne repasse
 * jamais côté backend et n'est pas persistable — un dump DB voit au
 * mieux le hash SHA-256.
 *
 * En cas de conflit `(user_id, name)` sur l'index partiel actif, le
 * INSERT lève — la route mappe vers 409.
 */

import { schema as dbSchema } from "@sqlnest/db";
import type { DbOrTx } from "../tunnels/db";
import {
	apiTokenDisplayPrefix,
	generateApiToken,
	hashApiToken
} from "./crypto";

export interface CreateApiTokenResult {
	readonly id: string;
	readonly name: string;
	readonly prefix: string;
	readonly token: string;
	readonly createdAt: Date;
}

export async function createApiToken(
	db: DbOrTx,
	userId: string,
	name: string
): Promise<CreateApiTokenResult> {
	const clear = generateApiToken();
	const rows = await db
		.insert(dbSchema.apiToken)
		.values({
			userId,
			name,
			hash: hashApiToken(clear),
			prefix: apiTokenDisplayPrefix(clear)
		})
		.returning({
			id: dbSchema.apiToken.id,
			name: dbSchema.apiToken.name,
			prefix: dbSchema.apiToken.prefix,
			createdAt: dbSchema.apiToken.createdAt
		});

	const row = rows[0];
	if (!row) {
		throw new Error("createApiToken: INSERT n'a rien renvoyé");
	}

	return {
		id: row.id,
		name: row.name,
		prefix: row.prefix,
		token: clear,
		createdAt: row.createdAt
	};
}
