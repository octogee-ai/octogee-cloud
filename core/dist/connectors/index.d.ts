import type { ConnectorDef } from "./def.js";
export type { ConnectorDef, ConnectorOAuthWebDef, ConnectorDeviceDef, ConnectorIdentity, } from "./def.js";
export declare function getConnector(id: string): ConnectorDef | undefined;
export declare function listConnectors(): ConnectorDef[];
export declare function isConnectorTokenBrokerable(id: string): boolean;
export declare function isConnectorAgentRuntimeTokenMaterializable(id: string): boolean;
export declare function connectorRedirectUri(def: ConnectorDef): string;
