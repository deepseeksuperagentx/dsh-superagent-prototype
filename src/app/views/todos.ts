/**
 * Todo lists of the worker Sessions behind live Tickets: what each piece of work still has to do.
 *
 * The list belongs to one agent Session (the `todo_write` tool replaces the whole list on every call), so a Ticket's
 * list is read from its one worker Session; a Ticket that has not started an Assignment has no list yet.
 */
import { workerSessionId } from '../../executor/dsh.ts'
import { ticketSummary, type TicketSummaryView } from './records.ts'
import type { Store } from '../store.ts'

export interface TodoItemView {
  content: string
  status: string
}

export interface TodoCountsView {
  total: number
  pending: number
  inProgress: number
  completed: number
}

export interface TodoTicketView {
  /** The same row the Ticket lists elsewhere show, so stage marks and links stay consistent. */
  ticket: TicketSummaryView
  sessionId: string
  started: boolean
  todos: TodoItemView[]
  counts: TodoCountsView
}

export interface TodoListView {
  items: TodoTicketView[]
  total: number
}

export interface TodoHost {
  readonly store: Pick<Store, 'tickets'>
  /** The `todos` projection of one Session, or undefined when the deployment composes no todo tool. */
  readTodos(sessionId: string): Promise<TodoItemView[] | undefined>
}

export function countsOf(todos: readonly TodoItemView[]): TodoCountsView {
  let pending = 0
  let inProgress = 0
  let completed = 0
  for (const todo of todos) {
    if (todo.status === 'completed') completed++
    else if (todo.status === 'in_progress') inProgress++
    else pending++
  }
  return { total: todos.length, pending, inProgress, completed }
}

/** Tickets that need a person first, then those being worked, then the ones idle between turns. */
const RANK: Record<string, number> = { person: 0, working: 1, idle: 2, ended: 3 }

export async function todoList({ store, readTodos }: TodoHost): Promise<TodoListView> {
  const items = await Promise.all(store.tickets.open().map(async ticket => {
    const started = ticket.assignments.some(item => item.startedAt)
    const sessionId = started ? workerSessionId(ticket.id) : ''
    const todos = sessionId ? await readTodos(sessionId).catch(() => undefined) : undefined
    const list = todos ?? []
    return { ticket: ticketSummary(ticket), sessionId, started, todos: [...list], counts: countsOf(list) }
  }))
  items.sort((left, right) => (RANK[left.ticket.stage] ?? 9) - (RANK[right.ticket.stage] ?? 9)
    || right.ticket.updatedAt.localeCompare(left.ticket.updatedAt))
  return { items, total: items.length }
}
