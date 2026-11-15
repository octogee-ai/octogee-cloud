import type { RequestHandler } from "express";
export declare function createCorsMiddleware(allowedOrigins?: readonly string[]): RequestHandler;
