import type { Operation } from "@octogee/shared/types/glm";

type Input = Record<string, unknown>;

const PREVIOUS_RELEASE_SLUG_KEY = "builderSlug";

export function operationInputFromStored(input: Input): Input {
  if (!Object.hasOwn(input, PREVIOUS_RELEASE_SLUG_KEY)) return input;
  const { [PREVIOUS_RELEASE_SLUG_KEY]: previous, ...current } = input;
  return Object.hasOwn(current, "userSlug") ? current : { ...current, userSlug: previous };
}

export function operationInputForStore(input: Input): Input {
  return typeof input.userSlug === "string" ? { ...input, [PREVIOUS_RELEASE_SLUG_KEY]: input.userSlug } : input;
}

export function operationForStore<T extends Pick<Operation, "input">>(operation: T): T {
  return { ...operation, input: operationInputForStore(operation.input) };
}
