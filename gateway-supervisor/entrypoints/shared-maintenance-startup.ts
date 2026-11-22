import { waitForInstalledSharedMaintenanceGate } from "@octogee/core/shared-maintenance-startup";

await waitForInstalledSharedMaintenanceGate("gateway", process.env);
