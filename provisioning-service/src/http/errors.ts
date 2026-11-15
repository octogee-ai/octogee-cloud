import type { Response } from "express";
import type { ProvisioningErrorBody, ProvisioningErrorCode } from "@octogee/shared/types/provisioning-service";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ProvisioningErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function sendError(response: Response, status: number, code: ProvisioningErrorCode, error: string): void {
  response.status(status).json({ code, error } satisfies ProvisioningErrorBody);
}
