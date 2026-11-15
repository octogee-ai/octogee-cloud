export function requestBlobStore(req) {
    const select = req.app.locals.workspaceBlobStore;
    return select?.();
}
export function blobStatus(error) {
    return String(error?.code);
}
