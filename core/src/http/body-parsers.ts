import express, { type Express, type Request } from "express";

const MM_REST_PROXY_PREFIX = "/api/v4/";
const OBSIDIAN_PAIRING_COMPLETE_PATH = "/api/connect/obsidian/pair/complete";
// Webhook paths whose signature is verified against the EXACT bytes received —
// JSON-parsing would mutate the wire form. The handler reads req.rawBody.
const RAW_BODY_WEBHOOK_PATHS = new Set([
  "/api/billing/webhook",
  "/api/email/webhook",
]);

// Strip a single trailing slash so /api/email/webhook/ also lands in the raw-body
// branch. Without this, a stray trailing slash would JSON-parse the body and the
// handler would 500 on missing rawBody (or worse, signature-fail).
function normalisePath(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

export function installBodyParsers(app: Express): void {
  app.use((req, res, next) => {
    if (req.path.startsWith(MM_REST_PROXY_PREFIX)) return next();
    if (RAW_BODY_WEBHOOK_PATHS.has(normalisePath(req.path))) {
      express.raw({ type: "application/json" })(req, res, (err) => {
        if (err) return next(err);
        (req as Request & { rawBody?: Buffer }).rawBody = req.body;
        next();
      });
      return;
    }
    const limit = normalisePath(req.path) === OBSIDIAN_PAIRING_COMPLETE_PATH ? "64kb" : "10mb";
    express.json({ limit })(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path.startsWith(MM_REST_PROXY_PREFIX)) return next();
    express.urlencoded({ extended: true })(req, res, next);
  });
}
