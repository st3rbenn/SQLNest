import { addConnectionCommand } from "../commands/add-connection";
import { connectCommand } from "../commands/connect";
import { linkProjectCommand } from "../commands/link-project";
import { listConnectionsCommand } from "../commands/list-connections";
import { logoutCommand } from "../commands/logout";
import { pingCommand } from "../commands/ping";
import { revokeConnectionCommand } from "../commands/revoke-connection";
import type { CommandDefinition } from "./command";

/** Sous-commandes de `sqlnest`, dans l'ordre de l'aide. */
export const COMMANDS: readonly CommandDefinition[] = [
	connectCommand,
	logoutCommand,
	pingCommand,
	addConnectionCommand,
	linkProjectCommand,
	listConnectionsCommand,
	revokeConnectionCommand
];
