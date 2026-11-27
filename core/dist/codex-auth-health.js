function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function deriveCodexAuthHealth(authStateText, profileId, now) {
    if (typeof authStateText !== "string" || authStateText.trim() === "") {
        return "ok";
    }
    let parsed;
    try {
        parsed = JSON.parse(authStateText);
    }
    catch {
        return "ok";
    }
    if (!isRecord(parsed) || !isRecord(parsed.usageStats)) {
        return "ok";
    }
    const stats = parsed.usageStats[profileId];
    if (!isRecord(stats) || stats.disabledReason !== "auth_permanent") {
        return "ok";
    }
    const until = stats.disabledUntil;
    if (typeof until === "number" && Number.isFinite(until) && until <= now) {
        return "ok";
    }
    return "needs_reauth";
}
function rejectedAt(authStateText, profileId) {
    if (authStateText === null)
        return null;
    const parsed = JSON.parse(authStateText);
    const stats = isRecord(parsed) && isRecord(parsed.usageStats)
        ? parsed.usageStats[profileId]
        : undefined;
    const at = isRecord(stats) ? stats.lastFailureAt : undefined;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
}
export async function checkSubscriptionAuthHealth(opts) {
    const log = opts.logFn ?? (() => { });
    let checked = 0;
    let needsReauth = 0;
    let signalled = 0;
    for (const target of opts.targets) {
        const label = `${target.agentId} ${target.provider}`;
        let stateText;
        try {
            stateText = await target.readAuthState();
        }
        catch (e) {
            log(`subscription-auth-health: WARN read failed for ${label} — ${e.message}`);
            continue;
        }
        checked++;
        if (deriveCodexAuthHealth(stateText, target.profileId, opts.now) !== "needs_reauth") {
            continue;
        }
        needsReauth++;
        const observedAt = rejectedAt(stateText, target.profileId);
        if (observedAt === null) {
            log(`subscription-auth-health: WARN ${label} login rejected without a lastFailureAt; not signalled`);
            continue;
        }
        try {
            await opts.signalNeedsReauth({ agentId: target.agentId, provider: target.provider, observedAt });
            signalled++;
            log(`subscription-auth-health: ${label} login rejected — signalled needs_reauth`);
        }
        catch (e) {
            log(`subscription-auth-health: WARN signal failed for ${label} — ${e.message}`);
        }
    }
    return { checked, needsReauth, signalled };
}
