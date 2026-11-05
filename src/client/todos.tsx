/**
 * Todos page: the todo list one worker Session keeps for each open Ticket, so a single screen shows what every piece of
 * work still has to do without opening each conversation.
 */
import { usePoll, type TodoListRow } from './api.ts'
import { ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { Hint, LoadState, SessionButton, StageMark, When } from './widgets.tsx'
import { valueLabel } from './text.ts'

const markOf = (status: string): string => status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '·'

function TodoLine({ row }: { row: TodoListRow }) {
  const { t, navigate } = usePanel()
  const { ticket, counts, todos } = row
  const mark = ticketMark(t, ticket)
  const done = counts.total ? Math.round((counts.completed / counts.total) * 100) : 0
  return <li className="dt-row dt-ticket" data-state={mark.dot}>
    <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={mark.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'execution',
        id: ticket.id })}>{ticket.title}</button></div>
      <div className="dt-row-meta dt-ticket-meta">
        {counts.total
          ? <span>{t('todosProgress', { done: counts.completed, total: counts.total })}</span>
          : <span>{t(row.started ? 'todosNone' : 'todosNotStarted')}</span>}
        {counts.inProgress > 0 && <span>{t('todosInProgress', { count: counts.inProgress })}</span>}
        <When at={ticket.updatedAt} />
        {row.sessionId && <SessionButton variant="outline" sessionId={row.sessionId} />}
      </div>
      {counts.total > 0 && <div className="dt-todo-bar" role="img" aria-label={t('todosProgress', { done: counts.completed,
        total: counts.total })}><span className="dt-todo-bar-fill" style={{ width: `${done}%` }} /></div>}
      {todos.length > 0 && <ul className="dt-todo-list">{todos.map((todo, index) => <li key={index} className="dt-todo-item"
        data-status={todo.status}><span className="dt-todo-mark" aria-hidden>{markOf(todo.status)}</span>
        <span>{todo.content}</span><span className="dt-todo-state">{valueLabel(t, 'todoStatus', todo.status)}</span></li>)}</ul>}
    </div>
  </li>
}

export function TodosPage() {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET todos'), [])
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Hint>{t('todosIntro')}</Hint>
    {data.items.length ? <ul className="dt-list dt-cards">{data.items.map(row => <TodoLine key={row.ticket.id} row={row} />)}</ul>
      : <Hint>{t('todosEmpty')}</Hint>}
  </>
}
