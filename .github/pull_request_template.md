## What changed

## Checklist

- [ ] Every commit is signed off with `git commit -s`; the `dco` check requires it.
- [ ] Documentation changes: links, commands, and the diff have been checked.
- [ ] Code changes: root lint and the affected package checks pass. In each package you changed: `npm ci`, the typecheck, and `npm test` pass locally (in `scripts/`, also `npm run gate`).
