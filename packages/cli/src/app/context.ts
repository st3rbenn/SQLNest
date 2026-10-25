import type { addConnection } from "../commands/add-connection";
import type { connect } from "../commands/connect/device-flow";
import type { connectWithToken } from "../commands/connect/token";
import type { listConnections } from "../commands/list-connections";
import type { logout } from "../commands/logout";
import type { ping } from "../commands/ping";
import type { revokeConnection } from "../commands/revoke-connection";
import type { probeConnection } from "../services/engine";
import type { serveTunnel } from "../tunnel/serve";
import type { Prompter } from "../ui/prompts";

/** Ce que les commandes appellent pour agir — remplaçable en test. */
export interface CliServices {
	readonly connect: typeof connect;
	readonly connectWithToken: typeof connectWithToken;
	readonly serveTunnel: typeof serveTunnel;
	readonly logout: typeof logout;
	readonly ping: typeof ping;
	readonly addConnection: typeof addConnection;
	readonly listConnections: typeof listConnections;
	readonly revokeConnection: typeof revokeConnection;
	/** Test d'une connexion avant de l'enregistrer (ADR-038 S2). */
	readonly probeConnection: typeof probeConnection;
	/** Prompter d'une commande ; celui par défaut tient une readline à fermer. */
	readonly prompter: () => Prompter;
}

export interface CliContext {
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
	readonly env?: NodeJS.ProcessEnv;
	readonly services: CliServices;
}
