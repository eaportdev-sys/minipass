import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

const MAX_DOC_BYTES = 24_000

type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

function repoRoot(ctx: PluginContext) {
  return ctx.location.project?.canonical || ctx.location.project?.directory || ctx.location.directory
}

function readRepoFile(root: string, name: string) {
  const file = path.join(root, name)
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { path: file, text: "" }
    const text = fs.readFileSync(file, "utf8")
    return {
      path: file,
      text: text.length > MAX_DOC_BYTES ? `${text.slice(0, MAX_DOC_BYTES)}\n\n[truncated by minipass-roadmap-guard]` : text,
    }
  } catch {
    return { path: file, text: "" }
  }
}

function section(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = markdown.match(new RegExp(`^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "im"))
  return (match?.[1] || "").trim()
}

function approved(task: string) {
  const status = section(task, "Status")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
  return /^approved$/i.test(status || "") || /^\s*status\s*:\s*approved\s*$/im.test(task)
}

function taskTitle(task: string) {
  return (
    section(task, "Task")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0] || "No current task declared"
  )
}

function allowedFiles(task: string) {
  return section(task, "Allowed files")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").replace(/^`|`$/g, "").trim())
    .filter(Boolean)
}

function formatList(items: string[], fallback: string) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`
}

export default Plugin.define({
  id: "minipass-roadmap-guard",
  async setup(ctx) {
    const root = repoRoot(ctx)

    const load = () => {
      const roadmap = readRepoFile(root, "ROADMAP.md")
      const task = readRepoFile(root, "CURRENT_TASK.md")
      const agents = readRepoFile(root, "AGENTS.md")
      const isApproved = approved(task.text)
      const title = taskTitle(task.text)
      const allowed = allowedFiles(task.text)
      return { roadmap, task, agents, isApproved, title, allowed }
    }

    await ctx.session.hook("prompt", (event) => {
      const state = load()
      event.metadata = {
        ...event.metadata,
        roadmapGuard: {
          task: state.title,
          approved: state.isApproved,
          allowed: state.allowed,
        },
      }
    })

    await ctx.session.hook("context", (event) => {
      const state = load()
      event.system.push({
        type: "text",
        text: [
          "# Minipass roadmap guard",
          "This local OpenCode plugin keeps Minipass roadmap/task context visible without removing tools or blocking general OpenCode usage.",
          `Current task: ${state.title}`,
          `Task approved for implementation: ${state.isApproved ? "yes" : "no"}`,
          "Allowed files/directories for implementation:",
          formatList(state.allowed, "No allowed files listed"),
          "",
          "Guard rules:",
          "1. Questions get answers only; do not edit files, commit, or push for a question-only request.",
          "2. If CURRENT_TASK.md is not Approved, do not make repository edits, commits, pushes, or destructive/mutating shell changes. Use read-only exploration and ask for approval first.",
          "3. If CURRENT_TASK.md is Approved, keep implementation changes inside the listed allowed files/directories and the user's current request.",
          "4. Do not remove tools from the model context. Let OpenCode permissions handle tool approval; use this guard as project policy context.",
          "5. Before implementation, state the plan and verification checklist when the user has not already approved a concrete plan.",
          "",
          "## CURRENT_TASK.md",
          state.task.text || "Missing CURRENT_TASK.md",
          "",
          "## ROADMAP.md",
          state.roadmap.text || "Missing ROADMAP.md",
          "",
          "## AGENTS.md excerpt",
          state.agents.text || "Missing AGENTS.md",
        ].join("\n"),
      })
    })
  },
})
