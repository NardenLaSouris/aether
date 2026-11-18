/**
 * Claude's task list: a checklist card in the timeline, and a compact pinned view above the message box.
 */
import { CheckCircle2, ChevronRight, Circle, ListTodo, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { TodoEntry } from '../../../shared/timeline'
import { classNames } from './ui'

function TodoRow({ todo }: { todo: TodoEntry }) {
  return (
    <li className="flex items-start gap-2 py-0.5">
      {todo.status === 'completed' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-sage" /> : todo.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-gold" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />}
      <span className={classNames('text-[12.5px]', todo.status === 'completed' ? 'text-ink-faint line-through' : todo.status === 'in_progress' ? 'font-medium text-ink' : 'text-ink-muted')}>{todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}</span>
    </li>
  )
}

export function TodoChecklist({ todos }: { todos: TodoEntry[] }) {
  return (
    <ul className="selectable">
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </ul>
  )
}

/** Above the message box: progress and the current step; unfolds into the whole list. */
export function PinnedTodos({ todos }: { todos: TodoEntry[] }) {
  const [open, setOpen] = useState(false)
  if (todos.length === 0) return null
  const done = todos.filter((todo) => todo.status === 'completed').length
  const current = todos.find((todo) => todo.status === 'in_progress')
  if (done === todos.length && !open) return null
  return (
    <div className="mx-auto mb-2 max-w-4xl rounded-md border border-line bg-panel/80">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]" aria-expanded={open}>
        <ListTodo className="size-3.5 text-gold" />
        <span className="font-medium text-ink">Tâches</span>
        <span className="text-ink-faint tabular-nums">
          {done}/{todos.length}
        </span>
        <span className="h-1 w-20 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <span className="block h-full rounded-full bg-sage transition-all" style={{ width: `${(done / todos.length) * 100}%` }} />
        </span>
        {current && <span className="min-w-0 flex-1 truncate text-ink-muted">{current.activeForm ?? current.content}</span>}
        <ChevronRight className={classNames('ml-auto size-3.5 shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto border-t border-line px-3 py-1.5">
          <TodoChecklist todos={todos} />
        </div>
      )}
    </div>
  )
}
