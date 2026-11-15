export async function readMattermostSecret(store, uid, secretId) {
    const secret = await store.secrets.get(uid, secretId);
    return secret === null || secret.kind === "connector" ? null : secret;
}
