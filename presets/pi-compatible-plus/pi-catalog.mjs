// Freeze inherited host tools, then let this Plus preset contribute Pi Core and explicit DSH extensions.

export const name = 'pi-compatible-plus-tool-catalog'
export const inject = ['tools', 'systemPrompt']

const GUIDANCE = [
  'The core tool contract is frozen to @earendil-works/pi-coding-agent 0.84.2.',
  'Use read and ls to inspect files and directories; find locates files and grep searches contents.',
  'Use write for new files or complete rewrites. Use one edit call with multiple disjoint edits[] entries for precise changes.',
  'Use bash for git, builds, tests, package managers, and other terminal work. Each bash call is a fresh non-persistent process.',
  'WebFetch, WebSearch, Task, TodoWrite, ExitPlanMode, Think, and SlashCommand are DSH-backed Plus extensions, not Pi 0.84.2 core tools.',
  'This preset is designed and tested only for DSH danger-full-access. Do not request sandbox escalation; if the active host policy is narrower, report the limitation.',
].join('\n')

export function apply(ctx) {
  const inherited = ctx.tools.schemas().map((schema) => schema.name).filter((toolName) => toolName !== 'run_code')
  if (inherited.length > 0) ctx.tools.restrict({ deny: inherited })

  // Keep DSH enforcement active while removing host-policy prose that repeats
  // this Full Access-only preset's contract and names non-existent Pi tool
  // parameters. Scoped contexts shadow the global providers by name; empty
  // text is filtered from the model-facing runtime-context snapshot.
  ctx.systemPrompt.context({ name: 'sandbox:policy', order: 110, text: '' })
  ctx.systemPrompt.context({ name: 'approval:policy', order: 115, text: '' })

  ctx.systemPrompt.section({ name: 'tool:pi-compatible-plus-catalog', order: 90, text: GUIDANCE })
}
