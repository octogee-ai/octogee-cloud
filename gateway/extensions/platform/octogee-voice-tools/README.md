# Octogee native Talk provider

This extension uses OpenClaw's native realtime voice provider, consultation,
and playback contracts. Its type gate checks the actual native source graph.
It does not post live voice turns into Mattermost or expose verbatim narration.
Gateway-edge captures finalized speech; the API archives a compact record after
the call using the centrally held conversation agent credential, without another model call.

The app inherits the current conversation when Voice starts. An open thread is
preserved; channel-level starts create an agent-authored archive root automatically.
Reconnects reuse that root. The launcher is hidden on Admin and other platform
pages. Workspace-agent and configured project-agent conversations are supported.
Project calls require current project membership and the project agent's own
credential. They do not advertise or forward workspace surface controls. Project
owners choose and preview the agent's voice in Project settings.

After building Octogee `core` and `shared`, run:

```sh
npm run typecheck -- /path/to/clean-openclaw-checkout <full-source-sha>
```

The selected checkout must have its own installed dependencies and be clean at
that exact commit. The native tarball packer runs this check before packaging.
The gateway image also loads the bundled extension against its actual installed
OpenClaw SDK to reject missing runtime exports. Unit tests cover behavior with
controlled speech, broker, and playback boundaries.
