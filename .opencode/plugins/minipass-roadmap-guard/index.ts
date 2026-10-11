import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

const MAX_DOC_BYTES = 24_000

function readFile(root: string, name: string) {
  try {
    const file = path.join(root, name)
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { path: file, text: "" }
    const text = fs.readFileSync(file, "utf8")
    return { path: file, text: text.length > MAX_DOC_BYTES ? text.slice(0, MAX_DOC_BYTES) + "\n\n[truncated by roadmap guard]" : text }
  } catch {
    return { path: path.join(root, name), text: "" }
  }
}

function approved(task: string) {
  return /^\s*Status\s*\n+\s*Approved\s*$/im.test(task) || /^\s*Status\s*:\s*Approved\s*$/im.test(task)
}

function taskTitle(task: string) {
  const match = task.match(/^##\s+Task\s*\n+([\s\S]*?)(?:\n##\s+|$)/im)
  return (match?.[1] || "No current task declared").trim().split("\n").filter(Boolean)[0] || "No current task declared"
}

function allowedFiles(task: string) {
  const match = task.match(/^##\s+Allowed files\s*\n+([\s\S]*?)(?:\n##\s+|$)/im)
  if (!match) return []
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
}

function riskyTool(name: string) {
  return /(^|[_-])(write|edit|patch|apply|shell|bash|exec|execute|delete|remove|move|rename|commit|push|subagent)([_-]|$)/i.test(name)
}

export default Plugin.define({
  id: "minipass-roadmap-guard",
  async setup(ctx) {
    const root = ctx.location.project?.canonical || ctx.location.project?.directory || ctx.location.directory

    const load = () => {
      const roadmap = readFile(root, "ROADMAP.md")
      const task = readFile(root, "CURRENT_TASK.md")
      const agents = readFile(root, "AGENTS.md")
      return { roadmap, task, agents, isApproved: approved(task.text), title: taskTitle(task.text), allowed: allowedFiles(task.text) }
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
      const allowed = state.allowed.length ? state.allowed.map((f) => `- ${f}`).join("\n") : "- No allowed files listed"
      event.system.push({
        type: "text",
        text: [
          "# Minipass roadmap guard",
          "You are working in the Minipass repository. Follow ROADMAP.md and CURRENT_TASK.md before making changes.",
          `Current task: ${state.title}`,
          `Task approved for implementation: ${state.isApproved ? "yes" : "no"}`,
          "Allowed files/directories for this task:",
          allowed,
          "",
          "Hard rules:",
          "1. If the user asks a question, answer only. Do not edit files.",
          "2. Do not change code unless CURRENT_TASK.md status is Approved.",
          "3. Stay inside the allowed files/directories listed in CURRENT_TASK.md.",
          "4. Before implementation, state the plan and verification checklist.",
          "5. Prefer reading repository/site files and explaining decisions before building or patching.",
          "6. Do not commit or push unless verification for the approved task is complete.",
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

      if (!state.isApproved) {
        for (const name of Object.keys(event.tools || {})) {
          if (riskyTool(name)) delete event.tools[name]
        }
        event.system.push({
          type: "text",
          text: "CURRENT_TASK.md is not Approved. High-risk edit/shell tools were removed for this model call. Ask the user to approve/update the current task before implementation.",
        })
      }
    })
  },
})
