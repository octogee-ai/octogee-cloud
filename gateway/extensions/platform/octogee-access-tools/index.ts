// @ts-expect-error resolved by the OpenClaw runtime
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { computerApprovalHook } from "./computer-approval.js";

export default definePluginEntry({
  id: "octogee-access-tools",
  name: "Octogee VM Authorization",
  description: "Authorize agent VM operations in the owning workspace.",
  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as { brokerUrl?: string; tokenPath?: string };
    api.on("before_tool_call", computerApprovalHook(config));
  },
});
