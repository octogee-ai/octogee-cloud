import { fileURLToPath } from "node:url";

process.env.OCTOGEE_DEPLOYMENT_TARGETS = fileURLToPath(new URL("../../../core/src/fixtures/deployment-targets.json", import.meta.url));
