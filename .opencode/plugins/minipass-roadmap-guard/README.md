# minipass-roadmap-guard

Local OpenCode plugin for this repository.

Purpose:

- Always load `ROADMAP.md`, `CURRENT_TASK.md`, and local repo instructions into session context.
- Make the model explain the current task before implementation.
- Remove high-risk tools from model calls unless `CURRENT_TASK.md` contains `Status: Approved`.
- Push work toward roadmap-driven changes instead of reactive patching.

This is not a replacement for review. It is a guardrail. Keep `CURRENT_TASK.md` accurate before asking for implementation.
