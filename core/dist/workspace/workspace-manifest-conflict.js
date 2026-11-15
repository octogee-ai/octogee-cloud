import { isDeepStrictEqual } from "node:util";
import { manifestObjectPath, parseManifest } from "../workspace-manifest.js";
function validUploadTime(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
export function isDuplicateAssetUpload(remote, local, prefix) {
    try {
        const objectPath = manifestObjectPath(prefix);
        const published = parseManifest(objectPath, remote);
        const replayed = parseManifest(objectPath, local);
        const keys = Object.keys(published).sort();
        if (!keys.length || !isDeepStrictEqual(keys, Object.keys(replayed).sort()))
            return false;
        let changedTime = false;
        for (const key of keys) {
            const { uploadedAt: remoteTime, ...remoteIdentity } = published[key];
            const { uploadedAt: localTime, ...localIdentity } = replayed[key];
            if (!remoteIdentity.sha256 || !validUploadTime(remoteTime) || !validUploadTime(localTime))
                return false;
            if (!isDeepStrictEqual(remoteIdentity, localIdentity))
                return false;
            changedTime ||= remoteTime !== localTime;
        }
        return changedTime;
    }
    catch {
        return false;
    }
}
