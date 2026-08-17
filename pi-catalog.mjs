// Scoped tool-catalog control for the independent Pi-compatible preset.
// Host-global DSH rows are hidden; the preset then contributes Pi core tools
// plus the explicitly documented DSH-backed extension tools.

export const name = 'pi-tool-catalog'
export const inject = ['tools', 'systemPrompt']

const CATALOG_GUIDANCE = [
  'Your core tool catalog follows @earendil-works/pi-coding-agent 0.84.2. Use the lower-case core tools with Pi-compatible schemas:',
  '- bash is for terminal work (git, build, tests, package managers).',
  '- read and ls inspect files and directories; find locates files; grep searches file contents.',
  '- write is for new files or complete rewrites. edit uses one atomic edits[] batch for precise replacements.',
  '- This preset may also expose DSH-backed extension tools for web, tasks, planning, todos, and reasoning.',
].join('\n')

export function apply(ctx) {
  // Restrict only the host-global names. An empty allow-list also filters
  // ancestor layers, which is where the preset's own tools live for agents.
  const hostToolNames = ctx.tools.schemas()
    .map((schema) => schema.name)
    .filter((toolName) => toolName !== 'run_code')
  ctx.tools.restrict({ deny: hostToolNames })

  ctx.systemPrompt.section({
    name: 'tool:pi-catalog',
    order: 90,
    text: CATALOG_GUIDANCE,
  })
}
