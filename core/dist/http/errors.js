import { logger, redactRequestPath } from "./logging.js";
const STATUS_MAP = {
    Unauthenticated: 401,
    "Invalid token": 401,
    "User not found": 404,
    Forbidden: 403,
    "Access denied": 403,
    "Admin access required": 403,
};
class ApiError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = "ApiError";
    }
}
export function errorHandler(err, req, res, _next) {
    if (err instanceof ApiError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
    }
    const status = STATUS_MAP[err.message] || 500;
    if (status >= 500) {
        logger.error(`Unhandled error: ${err.message}`, {
            path: redactRequestPath(req.path),
            method: req.method,
            stack: err.stack?.slice(0, 500),
        });
    }
    res.status(status).json({ error: err.message || "Internal server error" });
}
