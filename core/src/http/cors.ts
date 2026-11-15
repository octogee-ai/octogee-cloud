import cors from "cors";
import type { RequestHandler } from "express";
import { publicAppOriginsFromEnv } from "../public-app-origins.js";
import { isAllowedLocalhostOrigin } from "@octogee/shared/types/dev-origins";

export function createCorsMiddleware(allowedOrigins: readonly string[] = publicAppOriginsFromEnv()): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowed.has(origin) || isAllowedLocalhostOrigin(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Internal-Service-Key", "X-Requested-With"],
    credentials: true,
  });
}
