# minipass-roadmap-guard

Local OpenCode plugin for this repository.

Purpose:

- Load lightweight Minipass planning context into each session.
- Keep the current task and any allowed file scope visible to the model.
- Treat `CURRENT_TASK.md` and `ROADMAP.md` as planning context, not as an approval/status gate.
- Warn the model not to edit, commit, push, or run mutating repo commands unless the user asks for implementation.
- Keep OpenCode fully usable; this plugin does not remove tools from model calls.
- Push work toward scoped roadmap-driven changes instead of reactive patching.

This is not a replacement for review or OpenCode permissions. It is a lightweight context guardrail, not a tool blocker.
