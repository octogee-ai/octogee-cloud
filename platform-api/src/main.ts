import { mattermostUserIdentityProvider } from "../../gateway-edge/src/lib/mattermost-user-identity-provider.js";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { installUserIdentityProvider } from "@octogee/core/http/auth";
import { createPlatformApp } from "./app.js";
import { serveApi } from "./serve.js";

installUserIdentityProvider(mattermostUserIdentityProvider({ mattermostUrl: process.env.MM_INTERNAL_URL ?? "", store: platformStateStore }));
serveApi(createPlatformApp());
