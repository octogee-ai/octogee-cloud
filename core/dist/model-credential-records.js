export function modelCredentialConfig(record) {
    if (record === null)
        return undefined;
    return {
        modelCredential: {
            active: record.active,
            provider: record.provider,
            mode: record.mode,
            status: record.status,
            reasonCode: record.reasonCode,
            secretName: record.secretName,
            addedAt: record.addedAt,
            lastUsedAt: record.lastUsedAt,
            ...(record.fingerprint === null ? {} : { fingerprint: record.fingerprint }),
            ...(record.keyHash === null ? {} : { keyHash: record.keyHash }),
            ...(record.baseUrl === null ? {} : { baseUrl: record.baseUrl }),
            ...(record.model === null ? {} : { model: record.model }),
        },
    };
}
export async function readModelCredentialConfig(users, uid) {
    return modelCredentialConfig(await users.modelCredentials.get(uid));
}
export function modelCredentialActive(record) {
    return record?.active === true;
}
export function subscriptionIntegration(links) {
    if (links.length === 0)
        return undefined;
    const latest = [...links].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return {
        connected: links.some((link) => link.status === "connected"),
        ...(latest.gatewayId === null ? {} : { gatewayId: latest.gatewayId }),
        updatedAt: latest.updatedAt,
        providers: Object.fromEntries(links.map((link) => [link.provider, {
                provider: link.provider,
                modelCredentialProvider: link.modelCredentialProvider,
                status: link.status,
                connected: link.status === "connected",
                ...(link.gatewayId === null ? {} : { gatewayId: link.gatewayId }),
                ...(link.flowId === null ? {} : { flowId: link.flowId }),
                ...(link.reason === null ? {} : { reason: link.reason }),
            }])),
    };
}
export async function readSubscriptionIntegration(users, uid) {
    return subscriptionIntegration(await users.subscriptionLinks.list(uid));
}
