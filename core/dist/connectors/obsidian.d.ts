import { type ObsidianCommandRunner } from "./obsidian-headless.js";
import { type ConnectorDef } from "./def.js";
export declare function revokeObsidianConnection(fields: Record<string, string>, runner?: ObsidianCommandRunner): Promise<void>;
export declare const obsidianConnector: ConnectorDef;
