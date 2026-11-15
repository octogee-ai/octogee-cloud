import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { BROKER_PROVIDER_ID, createBrokerCatalog } from "./catalog.js";
import { registerBrokerProfiles } from "./broker-profiles.js";
import { registerBrokerInspection } from "./inspect.js";

export default definePluginEntry({
  id: "octogee-broker-tools", name: "Octogee Broker Discovery",
  description: "Credential-scoped discovery and owner-authorized private broker inspection",
  register(api: OpenClawPluginApi) {
    const catalog = createBrokerCatalog();
    api.registerProvider({ id: BROKER_PROVIDER_ID, label: "Octogee Broker Discovery", auth: [],
      catalog: { order: "late", run: catalog.runtime },
      resolveUsageAuth: async () => ({ handled: true }),
      fetchUsageSnapshot: async () => null,
    });
    api.registerModelCatalogProvider({ provider: BROKER_PROVIDER_ID, kinds: ["text"], liveCatalog: catalog.picker });
    registerBrokerInspection(api);
    registerBrokerProfiles(api);
  },
});
