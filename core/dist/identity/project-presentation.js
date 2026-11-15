export const NO_PROJECT_PRESENTATION = {
    remembersChannels: false,
    readProject: async () => null,
    createProject: async () => undefined,
    publishProjectMemberCount: async () => undefined,
    markProjectPendingDeletion: async () => undefined,
    readChannel: async () => null,
    writeChannel: async () => undefined,
};
let active = NO_PROJECT_PRESENTATION;
export function installProjectPresentation(presentation) {
    active = presentation;
}
export function projectPresentation() {
    return active;
}
