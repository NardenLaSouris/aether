/**
 * Reading what Claude asks the user (AskUserQuestion, ExitPlanMode) and building the answers (pure, tested).
 */

export interface ClaudeQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string; preview?: string }[]
}

/** The questions of an AskUserQuestion input, tolerant of a malformed one. */
export function readQuestions(input: unknown): ClaudeQuestion[] {
  const raw = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): ClaudeQuestion[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const question = typeof record.question === 'string' ? record.question : ''
    if (!question) return []
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return []
          const entry = option as Record<string, unknown>
          return typeof entry.label === 'string' ? [{ label: entry.label, description: typeof entry.description === 'string' ? entry.description : '', ...(typeof entry.preview === 'string' ? { preview: entry.preview } : {}) }] : []
        })
      : []
    return [{ question, header: typeof record.header === 'string' ? record.header : '', multiSelect: record.multiSelect === true, options }]
  })
}

/** One answer per question: the chosen labels (", " between several), or the free text. */
export function buildAnswers(questions: ClaudeQuestion[], selected: Record<number, string[]>, other: Record<number, string>): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const [index, question] of questions.entries()) {
    const free = (other[index] ?? '').trim()
    const picks = (selected[index] ?? []).filter((label) => question.options.some((option) => option.label === label))
    const parts = question.multiSelect ? [...picks, ...(free ? [free] : [])] : free ? [free] : picks.slice(0, 1)
    if (parts.length === 0) return null
    answers[question.question] = parts.join(', ')
  }
  return answers
}

/** The plan of an ExitPlanMode input (inline text, or nothing when Claude only wrote it to a file). */
export function readPlan(input: unknown): string {
  const plan = (input as { plan?: unknown } | null)?.plan
  return typeof plan === 'string' ? plan : ''
}
