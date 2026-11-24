import { Request, Response, NextFunction } from "express";
export declare let logger: import("@octogee/shared/server/service-logger").ServiceLogger;
export declare function setLogService(service: string): void;
export declare function redactRequestPath(path: string): string;
export declare function requestLogger(req: Request, res: Response, next: NextFunction): void;
