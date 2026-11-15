export declare function authenticatedRequestLimit(limit: number): import("express-rate-limit").RateLimitRequestHandler;
export declare function clientRequestLimit(limit: number, socketOnly?: boolean): import("express-rate-limit").RateLimitRequestHandler;
export declare const authenticationFailureLimit: import("express-rate-limit").RateLimitRequestHandler;
