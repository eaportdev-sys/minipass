# Minipass Roadmap

This file is the source of truth for product direction. Changes must follow this roadmap instead of one-off patches.

## Current mission

Minipass is a self-hosted app platform that should deploy common repositories quickly, safely, and predictably. The panel must understand a repository before it builds, respect the repository's own build instructions, and keep each site isolated by identity, files, environment, Compose project, containers, volumes, and history.

## Non-negotiable principles

1. **Analyze before build** — read repository files, Dockerfiles, package scripts, env examples, services, routes, and database hints before starting a long build.
2. **Respect the repository first** — repo-owned Dockerfiles, build folders, scripts, and declared outputs win over generic templates.
3. **Universal templates are fallback paths** — templates should help standard projects, not override a repo that already explains how to build itself.
4. **No silent shape changes** — do not split, merge, rewrite, or reclassify a site without explicit user intent or a clear preflight decision.
5. **Each site is isolated** — site ID, display name, app directory, `.env`, Compose project, containers, DB tools, Trash entry, deploy history, and lifecycle state must never bleed across sites.
6. **Fast path first** — optimize the critical path: cached dependencies, prebuilt base images, bounded health gates, and no repeated installs when avoidable.
7. **Safe by default** — running containers are not touched until a build and pre-swap checks succeed.
8. **Visible failures** — failures must say what decision failed and what the operator should do next. No vague stuck states.
9. **No unplanned code changes** — every code edit must map to `CURRENT_TASK.md` and stay inside its allowed scope.

## Architecture roadmap

### Phase 1 — Guardrails and discipline

- Keep `ROADMAP.md` and `CURRENT_TASK.md` current.
- Load `.opencode/plugins/minipass-roadmap-guard` in OpenCode sessions.
- No code edit, commit, or push without an approved current task and verification plan.

### Phase 2 — Repository intelligence

- Preflight must read repository files before deploy.
- Detect repo-owned Dockerfile, intended build context, output directory, package manager, workspaces, service folders, env examples, migrations, and database hints.
- Present the decision before long builds.

### Phase 3 — Build strategy

- Prefer repo-owned Dockerfile/build instructions.
- Use universal templates only when the repo lacks a clear build recipe.
- Cache package installs and avoid repeated nested installs when possible.
- Support root builds that output nested frontend bundles when the repo intends that.

### Phase 4 — Site lifecycle and isolation

- Distinguish clearly between never built, building, deployed, stopped, failed, cancelled, trashed, restored, and destroyed.
- Stop/delete/cancel must not leave confusing state on a recreated site.
- Start is only for a site with existing built containers/images; first run is Deploy.

### Phase 5 — Environment and configuration

- Read env examples from the build context and relevant child packages for root builds.
- Never overwrite user secrets.
- Map local frontend/backend URLs to published URLs only when safe and explicit.

## Before changing code

Every implementation task must answer:

1. What repository/site state is being read before making the decision?
2. Which files are allowed to change?
3. What behavior is intentionally not changing?
4. How will this be verified locally?
5. What operator-visible message changes?
