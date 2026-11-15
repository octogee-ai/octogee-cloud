import { mattermostUserIdentityProvider } from "../../gateway-edge/src/lib/mattermost-user-identity-provider.js";
import { platformStateStore } from "../../gateway-edge/src/lib/platform-state.js";
import { installUserIdentityProvider } from "../../gateway-edge/src/middleware/auth.js";
import { createPlatformApp } from "./app.js";
import { serveApi } from "./serve.js";

installUserIdentityProvider(mattermostUserIdentityProvider({ mattermostUrl: process.env.MM_INTERNAL_URL ?? "", store: platformStateStore }));
serveApi(createPlatformApp());
