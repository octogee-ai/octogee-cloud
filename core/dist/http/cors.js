import cors from "cors";
import { publicAppOriginsFromEnv } from "../public-app-origins.js";
import { isAllowedLocalhostOrigin } from "@octogee/shared/types/dev-origins";
const ALLOWED_ORIGINS = new Set(publicAppOriginsFromEnv());
function isAllowedOrigin(origin) {
    return ALLOWED_ORIGINS.has(origin) || isAllowedLocalhostOrigin(origin);
}
export const corsMiddleware = cors({
    origin: (origin, callback) => {
        if (!origin) {
            callback(null, true);
            return;
        }
        callback(null, isAllowedOrigin(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Internal-Service-Key", "X-Requested-With"],
    credentials: true,
});
