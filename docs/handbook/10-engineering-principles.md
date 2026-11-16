---
title: Engineering Principles
slug: 10-engineering-principles
order: 10
part: Dev Workflow
audience: [agent]
description: Reliable code with risk-based tests, explicit failures, root-cause fixes, and proportional effort.
updated: 2026-11-16
---

# Engineering Principles

Make behavior clear, failures observable, and changes easy to review. Choose
validation that catches the failures the change could introduce.

## Core

- **Test changed behavior, not files.** Start with a failing test for a bug,
  new logic branch, state transition, authorization boundary, parser, handler,
  or user interaction. One test may cover several implementation files. New
  tests are not required for prose, generated output, pure deletion, mechanical renames,
  formatting, or declarative changes already checked by the owning
  parser/linter. Do not create an implementation-detail test to satisfy a ritual.
- **No silent failures.** Every error path is explicit and observable — a log,
  a response code, or a thrown error. "If this fails, will I know immediately?"
  If not, add explicit handling.
- **Do not mask upstream bugs.** Validate untrusted input and external-system
  responses at trust boundaries. Inside owned code, fix double firing or
  malformed state at its source instead of accumulating fallbacks that hide it.
- **Fix root cause, not symptom.** Flaky test → find the race. Drifting config
  → fix the source.

The question is not “did every file get a new test?” It is “what could this
change break, and what is the cheapest signal that would catch that break?”

## Greenfield posture

Breaking changes are allowed. Update callers with the change instead of adding
compatibility shims or duplicate interfaces.

- Preserve user data. A breaking API or code change does not authorize deleting
  or orphaning stored data. Plan and verify any operation that changes it.
- Rebuild disposable development state when that is simpler than manual repair.
  First confirm it contains no data that needs to be retained.
- Update an incompatible dependency when a refactor requires it, with focused
  checks for the affected build and runtime behavior.

## Comments & config

- **No narrative comments.** Code expresses intent through naming; tests cover
  edge cases; specs/this-handbook describe design; PR descriptions hold history.
  Don't write multi-line `// WHY:` blocks — extract a well-named helper, or pin
  the edge case with a behavioral test. Don't reference the current task/fix/
  caller in a comment ("added for X flow") — it rots.
- **No environment conditionals.** Never branch on env name to pick a URL/value
  (`if test then chat-test… else chat…`). Derive values from Kubernetes, Helm,
  or explicit environment configuration.

## Dependency posture

Use a current stable version when adding or intentionally upgrading a
dependency. Do not bump unrelated dependencies merely because a file was
touched. Security updates are prompt; routine currency is batched. Native
dependencies need a clean install/build check because install-script policy is
part of their runtime contract.

## Paying down debt: net-first, then cut

Eslint warning counts are a *lagging* indicator — the real smell is test
coverage inversely correlated with churn × criticality. When tackling a
tangled/high-blast-radius file, write the characterization test (pin the
intended behavior, mock at the seams so it survives the refactor) for the
highest churn×blast-radius file **first**; the refactor/split/lint cleanup
falls out cheaply and safely once the net is in place. Do not let a refactor
expand into an unrelated program. A nearby clear defect may be fixed in the
same PR when it is small and covered; otherwise report it. Use
the import-graph coverage audit ([11 — Testing](11-testing.md)) to find the
next target — never a filename glob.

## Reusable atoms over inline one-offs

Extract a reusable primitive when repetition is causing drift or slowing the
current change. There is no “third occurrence” mandate and no requirement to
sweep every caller in the same PR. Prefer a small typed API when extraction
actually earns its keep.

## Calibrated effort

- **Proportionate fixes, not programs.** For a "get it back to working"
  regression, find the existing mechanism that regressed and the minimal lever to
  restore it — don't architect an SSOT + guard + multi-PR program. If you catch
  yourself writing "Phase 1/2/3" for a regression repair, shrink it.
- **No premature perf optimization.** No pacing/queues/sync-vs-async splits in the
  provisioner/fleet path without a concrete trace showing the bottleneck.
- **Right net for the bug class.** Index-presence and render-time-env bugs are not
  caught by more emulator tests — they need declarative config + fail-loud-at-boot
  + a live exercise. Reach for the net that actually catches the class.
- **Precise risk framing.** Distinguish an immutable artifact proven in prod from
  a build step that would only fail if re-run. Don't dramatize dead-code or
  stale-rebuild as live production risk.

Related: [11 — Testing](11-testing.md), [12 — PR & Effort Workflow](12-pr-and-effort-workflow.md), [13 — Repo Conventions](13-repo-conventions.md).
