import { ipKeyGenerator, rateLimit } from "express-rate-limit";

export function authenticatedRequestLimit(limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: req => req.uid!,
    message: { error: "Too many requests, please try again later." },
  });
}

export function clientRequestLimit(limit: number, socketOnly = false) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator((socketOnly ? req.socket.remoteAddress : req.ip) ?? "unknown"),
    message: { error: "Too many requests, please try again later." },
  });
}

export const authenticationFailureLimit = rateLimit({
  windowMs: 60_000,
  limit: 1200,
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
  skipSuccessfulRequests: true,
  requestWasSuccessful: req => Boolean(req.uid),
  message: { error: "Too many authentication attempts, please try again later." },
});
