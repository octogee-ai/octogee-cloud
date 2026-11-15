

export interface ResolveGcpProjectOpts {
  
  gcpProject?: string;
  
  platformDefault: string;
}

export function resolveGatewayGcpProject(opts: ResolveGcpProjectOpts): string {
  const perGateway = opts.gcpProject?.trim();
  if (perGateway) return perGateway;
  const platform = opts.platformDefault?.trim();
  if (!platform) {
    throw new Error(
      "resolveGatewayGcpProject: no per-gateway gcpProject and no platform default — " +
        "refusing to render an empty GCP_PROJECT_ID (would silently break gateway-token resolution).",
    );
  }
  return platform;
}
