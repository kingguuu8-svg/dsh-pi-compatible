// Pi-compatible plan mode: a session-scoped active flag, the /plan command,
// and the ExitPlanMode review gate. This preset owns the state so its
// PascalCase extension tool remains separate from DSH's global exit_plan_mode.
// State is in-memory per session and resets when the host restarts.

export const name = 'pi-plan'
export const inject = ['tools', 'systemPrompt']

const PLAN_POLICY = [
  'You are in plan mode. Stay in plan mode until ExitPlanMode succeeds or the user switches the session mode.',
  'Do not edit files, run mutating commands, or change configuration. Explore with read, find, grep, ls, WebFetch, and WebSearch; run only read-only bash commands; do not delegate mutating work to Task subagents.',
  'Present a decision-complete plan through ExitPlanMode and make it your final tool call in the response.',
].join('\n')

export function apply(ctx) {
  const active = new WeakSet()

  ctx.systemPrompt.section({
    name: 'plan:policy',
    order: 50,
    text: (context) => context.agent !== undefined && active.has(context.agent.session) ? PLAN_POLICY : '',
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'plan',
      description: 'Enter or leave plan mode',
      input: { hint: '[off|message]' },
      handler: ({ agent, rawInput }) => {
        const message = rawInput.trim()
        if (message === 'off') {
          if (active.has(agent.session)) {
            active.delete(agent.session)
            return { kind: 'success', text: 'Plan mode off.' }
          }
          return { kind: 'success', text: 'Plan mode is already inactive.' }
        }
        active.add(agent.session)
        return { kind: 'success', text: 'Plan mode on. Present the complete plan through ExitPlanMode; use /plan off to leave.' }
      },
    })
  })

  ctx.tools.register({
    name: 'ExitPlanMode',
    description: 'Present the complete plan for the user\'s review and, on approval, leave plan mode. Only available in plan mode. Make it your only and final tool call in the response: the plan is shown to the user, who approves it (execution begins) or keeps planning (their feedback comes back in the tool result; revise and present again).',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        plan: { type: 'string', description: 'The complete plan, as markdown, starting with a # heading that names it.' },
      },
      required: ['plan'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { approved: { type: 'boolean', const: true } },
        required: ['approved'],
      },
      render: () => [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('ExitPlanMode requires a calling agent (no session to switch)')
      if (!active.has(agent.session)) throw new Error('ExitPlanMode is only available in plan mode')
      if (typeof args.plan !== 'string' || !/^#\s+\S/.test(args.plan.trim())) {
        throw new Error('ExitPlanMode requires a non-empty markdown plan starting with a # heading')
      }
      const interaction = ctx.get('userQuestions')
      if (interaction === undefined) {
        throw new Error('no user-questions channel is available to review the plan; ask the user to switch the session mode instead')
      }
      const answer = await interaction.ask({
        questions: [{
          id: 'pi-plan-review',
          header: 'Plan review',
          question: 'Approve this plan and start executing?',
          detail: args.plan,
          options: [
            { label: 'Approve plan', description: 'Leave plan mode; the plan is carried out from the next step.' },
            { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
          ],
        }],
        agent,
        signal: exec.signal,
      }).catch((cause) => {
        throw new Error(`The plan review was dismissed or cancelled: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
      const item = answer.answers.find((entry) => entry.id === 'pi-plan-review')
      if (item === undefined || item.selected.length !== 1 || item.selected[0] !== 'Approve plan') {
        const feedback = item?.custom ?? ''
        throw new Error(feedback === ''
          ? 'The user chose to keep planning; revise the plan and present it again.'
          : `The user chose to keep planning; their feedback: ${feedback}`)
      }
      active.delete(agent.session)
      return { approved: true }
    },
  })
}
