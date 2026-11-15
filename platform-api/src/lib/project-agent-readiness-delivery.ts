import { completeProjectAgentActivations } from "./project-agent-readiness.js";
import { deliverProjectAgentOnboarding } from "../../../gateway-edge/src/lib/project-agent-onboarding.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";

export async function completeProjectAgentReadiness(
  store: Parameters<typeof completeProjectAgentActivations>[0],
  input: Parameters<typeof completeProjectAgentActivations>[1],
): Promise<boolean> {
  if (!await completeProjectAgentActivations(store, input)) return false;
  for (const project of input.projects) {
    try {
      await deliverProjectAgentOnboarding(input.uid, input.slug, project.projectId);
    } catch (error) {
      logger.error("Project onboarding delivery failed", { uid: input.uid, projectId: project.projectId, error });
    }
  }
  return true;
}
