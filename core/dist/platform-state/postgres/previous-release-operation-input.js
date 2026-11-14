const PREVIOUS_RELEASE_SLUG_KEY = "builderSlug";
export function operationInputFromStored(input) {
    if (!Object.hasOwn(input, PREVIOUS_RELEASE_SLUG_KEY))
        return input;
    const { [PREVIOUS_RELEASE_SLUG_KEY]: previous, ...current } = input;
    return Object.hasOwn(current, "userSlug") ? current : { ...current, userSlug: previous };
}
export function operationInputForStore(input) {
    return typeof input.userSlug === "string" ? { ...input, [PREVIOUS_RELEASE_SLUG_KEY]: input.userSlug } : input;
}
export function operationForStore(operation) {
    return { ...operation, input: operationInputForStore(operation.input) };
}
