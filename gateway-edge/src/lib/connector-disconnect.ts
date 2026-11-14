export type ConnectorDisconnected = (uid: string, connectorId: string) => Promise<void>;

export const NO_CONNECTOR_DISCONNECTED: ConnectorDisconnected = async () => undefined;

let active: ConnectorDisconnected = NO_CONNECTOR_DISCONNECTED;

export function installConnectorDisconnected(hook: ConnectorDisconnected): void {
  active = hook;
}

export function connectorDisconnected(): ConnectorDisconnected {
  return active;
}
