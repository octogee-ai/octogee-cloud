import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerActivityPlugin } from "./plugin-runtime-native.js";
import { createEdgeRelayClient, podRelayToken } from "./edge-relay-client.js";
import { registerFinalReplyNotifications } from "./final-reply-notifications.js";

export default definePluginEntry({
  id: "octogee-activity-tools",
  name: "Octogee Activity Source",
  description: "Relay native agent events and delivered replies to the hosted workspace.",
  register(api: OpenClawPluginApi) {
    registerActivityPlugin(api);
    registerFinalReplyNotifications(api, () => createEdgeRelayClient({ gatewayToken: podRelayToken() }));
  },
});
