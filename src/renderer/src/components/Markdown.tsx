import { Check, Copy } from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { classNames } from './ui'

export function CopyButton({ text, label = 'Copier', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }}
      className={classNames('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-white/6 hover:text-ink', className)}
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      {copied ? 'Copié' : label}
    </button>
  )
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const language = /language-([\w+-]+)/.exec(className ?? '')?.[1]
  const code = textOf(children).replace(/\n$/, '')
  return (
    <div className="my-3 overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex items-center justify-between border-b border-line bg-black/15 px-3 py-1">
        <span className="font-mono text-[11px] text-sage">{language ?? 'texte'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
}

/** Markdown with GFM tables, syntax highlighting and copyable code blocks. Raw HTML is never rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-aether selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        skipHtml
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? '') || textOf(children).includes('\n')
            if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>
            return <code className={className}>{children}</code>
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
