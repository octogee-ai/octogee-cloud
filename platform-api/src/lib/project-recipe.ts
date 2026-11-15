import {
  isProjectRecipeId,
  PROJECT_RECIPE_IDS,
  type ProjectRecipeId,
} from "@octogee/shared/types/project";

const INVALID_PROJECT_RECIPE =
  `Invalid recipe (expected one of ${PROJECT_RECIPE_IDS.join(", ")})`;

type RequestedProjectRecipe =
  | { ok: true; value: ProjectRecipeId }
  | { ok: false; error: string };

export function requestedProjectRecipe(value: unknown): RequestedProjectRecipe {
  if (value === undefined) return { ok: false, error: "recipe is required" };
  if (!isProjectRecipeId(value)) return { ok: false, error: INVALID_PROJECT_RECIPE };
  return { ok: true, value };
}
