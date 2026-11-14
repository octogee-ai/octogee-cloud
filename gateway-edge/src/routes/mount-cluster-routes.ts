import { Express, RequestHandler, Router } from "express";

import mattermostRoutes from "./mattermost.js";
import openclawRoutes from "./openclaw.js";
import agentModelRoutes from "./agent-models.js";
import channelSessionModelRoutes from "./channel-session-models.js";
import modelCredentialRoutes from "./model-credentials.js";
import adminRoutes from "./admin.js";
import connectRoutes from "./connect.js";
import entitiesRoutes from "./entities.js";
import agentRoutes from "./agents.js";
import isolatedGatewaysRoutes from "./user/gateways.js";
import productivityApprovalRoutes from "./productivity-approvals.js";
import voiceRoutes from "./voice.js";

import workspaceDisplayNameRoutes from "./workspace/display-name.js";
import workspaceFilesRoutes from "./workspace/files.js";
import workspaceIssuesRoutes from "./workspace/issues.js";
import workspacePulseRoutes from "./workspace/pulse.js";
import workspaceSaveRoutes from "./workspace/save.js";
import workspaceUploadRoutes from "./workspace/upload.js";
import workspaceDeleteBlobRoutes from "./workspace/delete-blob.js";
import workspaceExtractZipRoutes from "./workspace/extract-zip.js";
import workspaceImportRepoRoutes from "./workspace/import-repo.js";
import workspaceGithubReposRoutes from "./workspace/github-repos.js";

import channelsRoutes from "./channels/index.js";

import projectsReadmeRoutes from "./projects/readme.js";
import projectsCreateRoutes from "./projects/create.js";
import projectsRetryRoutes from "./projects/retry.js";
import projectsJoinLeaveRoutes from "./projects/join-leave.js";
import projectsStarRoutes from "./projects/star.js";
import projectsMembersRoutes from "./projects/members.js";
import projectsAgentRoutes from "./projects/agent.js";
import projectsRepoSourceRoutes from "./projects/repo-source.js";
import projectsRecipeRoutes from "./projects/recipe.js";
import projectsSettingsRoutes from "./projects/settings.js";

import internalWorkspaceCommitRoutes from "./internal/workspace-commit.js";

import { requireAuth } from "../middleware/auth.js";

export type ClusterRouteTable = readonly (readonly [string, RequestHandler | Router])[];

export interface MountClusterRoutesOpts {
  mmRestProxyHandler?: RequestHandler;
  mattermostMintRoutes?: Router;
  productRoutes?: ClusterRouteTable;
  isolatedGatewaysRoutes?: Router;
  projectsCreateRoutes?: Router;
  projectsDeleteRoutes?: Router;
  projectsRepoSourceRoutes?: Router;
  productivityApprovalRoutes?: Router;
  voiceRoutes?: Router;
  adminRoutes?: Router;
}

type RouteHandler = RequestHandler | Router;

const WORKSPACE_ROUTES: readonly RouteHandler[] = [
  requireAuth,
  workspaceDisplayNameRoutes,
  workspaceFilesRoutes,
  workspaceIssuesRoutes,
  workspacePulseRoutes,
  workspaceSaveRoutes,
  workspaceUploadRoutes,
  workspaceDeleteBlobRoutes,
  workspaceExtractZipRoutes,
  workspaceImportRepoRoutes,
  workspaceGithubReposRoutes,
];

const CHANNEL_ROUTES: readonly RouteHandler[] = [requireAuth, channelsRoutes];

function projectRoutes(opts: MountClusterRoutesOpts): readonly RouteHandler[] {
  return [
    projectsReadmeRoutes,
    ...(opts.projectsDeleteRoutes ? [opts.projectsDeleteRoutes] : []),
    requireAuth,
    opts.projectsCreateRoutes ?? projectsCreateRoutes,
    projectsRetryRoutes,
    projectsJoinLeaveRoutes,
    projectsStarRoutes,
    projectsMembersRoutes,
    projectsAgentRoutes,
    opts.projectsRepoSourceRoutes ?? projectsRepoSourceRoutes,
    projectsRecipeRoutes,
    projectsSettingsRoutes,
  ];
}

const PUBLIC_API_ROUTES: readonly (readonly [string, RouteHandler])[] = [
  ["/api/entities", entitiesRoutes],
  ["/api/mattermost", mattermostRoutes],
  ["/api/openclaw", openclawRoutes],
  ["/api/agent-models", agentModelRoutes],
  ["/api/channel-session-models", channelSessionModelRoutes],
  ["/api/model-credentials", modelCredentialRoutes],
  ["/api/admin", adminRoutes],
  ["/api/connect", connectRoutes],
  ["/api/agents", agentRoutes],
  ["/api/builder", isolatedGatewaysRoutes],
  ["/api/productivity-approvals", productivityApprovalRoutes],
  ["/api/voice", voiceRoutes],
];

const INTERNAL_ROUTES: readonly (readonly [string, RouteHandler])[] = [
  ["/internal/agents", agentRoutes],
  ["/internal/workspace", internalWorkspaceCommitRoutes],
];

export function mountClusterRoutes(app: Express, opts: MountClusterRoutesOpts = {}): void {
  if (opts.mmRestProxyHandler) {
    app.all("/api/v4/*splat", opts.mmRestProxyHandler);
  }

  mountGroup(app, "/api/workspace", WORKSPACE_ROUTES);
  mountGroup(app, "/api/channels", CHANNEL_ROUTES);
  mountGroup(app, "/api/projects", projectRoutes(opts));

  if (opts.mattermostMintRoutes) {
    app.use("/api/auth/mattermost", opts.mattermostMintRoutes);
  }

  mountRouteTable(app, PUBLIC_API_ROUTES.map(([path, route]) => {
    if (path === "/api/builder") return [path, opts.isolatedGatewaysRoutes ?? route] as const;
    if (path === "/api/productivity-approvals") {
      return [path, opts.productivityApprovalRoutes ?? route] as const;
    }
    if (path === "/api/voice") return [path, opts.voiceRoutes ?? route] as const;
    if (path === "/api/admin") return [path, opts.adminRoutes ?? route] as const;
    return [path, route] as const;
  }));
  mountRouteTable(app, opts.productRoutes ?? []);
  mountRouteTable(app, INTERNAL_ROUTES);
}

function mountGroup(app: Express, path: string, routes: readonly RouteHandler[]): void {
  for (const route of routes) {
    app.use(path, route);
  }
}

function mountRouteTable(app: Express, routes: ClusterRouteTable): void {
  for (const [path, route] of routes) {
    app.use(path, route);
  }
}
