import { createGiteaGitHost, type GiteaGitHost } from "@octogee/core/git-host";

import { GITEA_URL, getToken } from "@octogee/core/git-host/gitea-client";

let host: GiteaGitHost | undefined;

export function gitHost(): GiteaGitHost {
  host ??= createGiteaGitHost({
    apiBaseUrl: `${GITEA_URL}/api/v1`,
    token: getToken,
  });
  return host;
}
