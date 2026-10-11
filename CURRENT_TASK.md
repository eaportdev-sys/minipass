# Current Task

## Status

Done

## Task

Install project guardrails so future OpenCode work follows the roadmap instead of ad-hoc patching.

## Why

Recent deploy fixes became reactive and changed behavior without a stable plan. The project needs an explicit roadmap, one active task at a time, and an OpenCode guard plugin that keeps the roadmap and current task in context.

## Allowed files

- `ROADMAP.md`
- `CURRENT_TASK.md`
- `.opencode/plugins/minipass-roadmap-guard/index.ts`
- `.opencode/plugins/minipass-roadmap-guard/README.md`

## Rules for future tasks

1. Change this file to `Status: Approved` before implementation starts.
2. Keep one task only.
3. List exact allowed files or directories.
4. Add a verification checklist before code edits.
5. Set status back to `Done` after commit/push.

## Verification

- [x] Roadmap file exists.
- [x] Current task file exists.
- [x] Local OpenCode guard plugin exists.
- [x] Plugin reads roadmap/task files and injects policy into model context.
- [x] Plugin blocks high-risk tools unless the current task is approved.
