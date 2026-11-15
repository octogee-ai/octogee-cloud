/**
 * Octogee Workspace Tools — `workspace_commit`
 *
 * An exec-free "save now" for agents. Workspace and project agents run exec-off
 * (`tools.deny: ["exec", "process"]`), so they can't `git commit` their
 * workspace. Agents use this tool for an intentional commit and push.
 *
 * Wraps the in-pod gateway-edge endpoint `POST /internal/workspace/commit`.
 * The slug and request proof are derived from the selected agent identity.
 *
 * Imports `openclaw/plugin-sdk/core` and `typebox` resolve at runtime via the
 * gateway base image; this file is not locally typechecked (matches the other
 * octogee-* extensions). Tests target the pure modules + a contract test that
 * vi.mocks the SDK import.
 */

// @ts-expect-error — resolved at runtime via the gateway base image's openclaw install (no local types)
import { definePluginEntry, jsonResult } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

import { resolveLane, type WorkspaceToolContext } from "./slug.js";
import { WorkspaceToolError } from "./errors.js";
import { createCommitClient, DEFAULT_CONTROL_URL } from "./commit-client.js";
import { readMattermostAgentProofSecret } from "./mattermost-agent-proof.js";

interface PluginConfig {
  controlUrl?: string;
}

interface ToolCtx extends WorkspaceToolContext {
  agentId?: unknown;
}

interface PluginRegisterApi {
  pluginConfig?: unknown;
  logger?: { debug?: (msg: string) => void };
  registerTool: (factory: (ctx: ToolCtx) => unknown, meta: { name: string }) => void;
}

const COMMIT_DESCRIPTION = [
  "Commit and push your workspace right now.",
  "Use this to commit and push your work explicitly after finishing a task, completing onboarding, or when the user asks.",
  "Edits remain local until you intentionally commit and push.",
  "Returns whether anything was committed and pushed; a clean no-op if there were no changes.",
].join(" ");

export default definePluginEntry({
  id: "octogee-workspace-tools",
  name: "Octogee Workspace Tools",
  description: "Commit + push the user's workspace on demand (exec-free).",
  register(api: PluginRegisterApi) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const controlUrl = config.controlUrl || DEFAULT_CONTROL_URL;
    const client = createCommitClient({
      controlUrl,
      agentProofSecretProvider: async (agentId) => {
        const lane = resolveLane({ agentId });
        const accountId = lane.project ? `${lane.slug}-proj-${lane.project}` : `${lane.slug}-coach`;
        return readMattermostAgentProofSecret(accountId);
      },
    });

    api.registerTool(
      (ctx: ToolCtx) => ({
        name: "workspace_commit",
        description: COMMIT_DESCRIPTION,
        parameters: Type.Object({
          message: Type.Optional(
            Type.String({
              description: "Optional commit message. Defaults to 'agent: workspace commit'.",
            }),
          ),
        }),
        async execute(_toolCallId: string, rawParams: Record<string, unknown>): Promise<unknown> {
          const message = typeof rawParams.message === "string" ? rawParams.message : undefined;
          try {
            const lane = resolveLane(ctx);
            const result = await client.commit(ctx.agentId as string, lane.slug, message, lane.project ?? undefined);
            return jsonResult({
              committed: result.committed,
              pushed: result.pushed,
              nothing_to_commit: result.nothingToCommit,
              diverted_blobs: result.divertedBlobs,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      }),
      { name: "workspace_commit" },
    );

    api.logger?.debug?.("[workspace-tools] tools registered: workspace_commit");
  },
});

export function errorResult(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof WorkspaceToolError ? err.code : "error";
  const edgeCode = err instanceof WorkspaceToolError ? err.edgeCode : undefined;
  const paths = err instanceof WorkspaceToolError ? err.paths : undefined;
  return jsonResult({
    error: `workspace_commit failed: ${message}`,
    code,
    ...(edgeCode ? { edge_code: edgeCode } : {}),
    ...(paths?.length ? { paths } : {}),
    committed: false,
    pushed: false,
  });
}
