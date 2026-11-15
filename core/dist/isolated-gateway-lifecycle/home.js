export class HomeCopyFailure extends Error {
}
export function homeCopyCapacity(input) {
    if (![10, 50, 100].includes(input.desiredGiB) || !Number.isSafeInteger(input.sourceGiB) || input.sourceGiB < 10 || !Number.isSafeInteger(input.usedBytes) || input.usedBytes < 0)
        throw new Error("invalid home copy capacity");
    const needed = Math.ceil((input.usedBytes * 1.1 + 2 * 1024 ** 3) / 1024 ** 3);
    const allocation = needed <= input.desiredGiB ? input.desiredGiB : Math.max(input.sourceGiB, input.desiredGiB);
    if (needed > allocation)
        throw new Error("home copy needs more space than the retained allocation; source retained");
    return allocation;
}
export function userHomeOwner(user) {
    return user.home;
}
export function isActiveHomeMigration(state) {
    return state !== undefined && "id" in state;
}
