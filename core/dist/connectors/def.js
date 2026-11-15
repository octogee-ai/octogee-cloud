import { CONNECTOR_CATALOG } from "@octogee/shared/types/connectors";
export function catalogMeta(id) {
    const meta = CONNECTOR_CATALOG.find((m) => m.id === id);
    if (!meta) {
        throw new Error(`Connector ${id} is missing from CONNECTOR_CATALOG`);
    }
    return meta;
}
