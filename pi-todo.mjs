// Pi-faithful TodoWrite tool. Reuses the host's durable todo/write session
// event, so the same UI surfaces that render the official todo_write tool
// render this one. activeForm is accepted for Pi compatibility and not
// persisted (the DSH todo event has no slot for it).

export const name = 'pi-todo'
export const inject = ['tools']

const STATUSES = ['pending', 'in_progress', 'completed']

export function apply(ctx) {
  ctx.tools.register({
    name: 'TodoWrite',
    description: 'Create and manage a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list (there are no partial updates, no per-item edits). Use it to plan multi-step work and show progress: add one todo per concrete step before you start. Mark a todo completed the moment it is done. Statuses: pending (not started), in_progress (working on it now), completed (finished).',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        todos: {
          type: 'array',
          description: 'The COMPLETE task list, replacing any previous list. May be empty to clear the list.',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              content: { type: 'string', description: 'What the task is — a short imperative line.' },
              status: { type: 'string', enum: STATUSES, description: 'pending | in_progress | completed.' },
              activeForm: { type: 'string', description: 'Optional text to include in your response right before you start working on this todo. Accepted for compatibility; not shown in the UI.' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: STATUSES },
              },
              required: ['content', 'status'],
            },
          },
          counts: {
            type: 'object', additionalProperties: false,
            properties: {
              pending: { type: 'integer' },
              inProgress: { type: 'integer' },
              completed: { type: 'integer' },
            },
            required: ['pending', 'inProgress', 'completed'],
          },
        },
        required: ['todos', 'counts'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${String(value.counts.pending)} pending, ${String(value.counts.inProgress)} in progress, ${String(value.counts.completed)} completed.`,
      }],
    },
    presentCall(args) {
      if (!Array.isArray(args.todos)) return undefined
      return { card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('TodoWrite requires an owning agent session')
      if (!Array.isArray(args.todos)) throw new Error('todos must be an array')
      const todos = args.todos.map((item, index) => {
        const content = typeof item.content === 'string' ? item.content.trim() : ''
        if (content.length === 0) throw new Error(`todos[${String(index)}].content must be a non-empty string`)
        if (!STATUSES.includes(item.status)) throw new Error(`todos[${String(index)}].status must be one of ${STATUSES.join(', ')}`)
        return { content, status: item.status }
      })
      agent.session.append('todo/write', { todos })
      const count = (status) => todos.filter((todo) => todo.status === status).length
      return {
        todos,
        counts: { pending: count('pending'), inProgress: count('in_progress'), completed: count('completed') },
      }
    },
  })
}
