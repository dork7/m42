import { Fragment, type ReactNode } from 'react'

/**
 * Minimal Markdown renderer — just enough for the AI CHECK response:
 * paragraphs, `*` / `-` bullet lists, `**bold**`, `*italic*`, and `` `code` ``.
 * Not a general Markdown engine; no external dependency.
 */

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // Split on **bold**, *italic*, `code` while keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g)
  parts.forEach((part, i) => {
    if (!part) return
    const key = `${keyBase}-${i}`
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>,
      )
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-surface px-1 py-0.5 text-[0.92em]">
          {part.slice(1, -1)}
        </code>,
      )
    } else if (
      part.startsWith('*') &&
      part.endsWith('*') &&
      part.length > 2
    ) {
      nodes.push(<em key={key}>{part.slice(1, -1)}</em>)
    } else {
      nodes.push(<Fragment key={key}>{part}</Fragment>)
    }
  })
  return nodes
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }

function toBlocks(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  let para: string[] = []
  let list: string[] = []

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'p', text: para.join(' ').trim() })
      para = []
    }
  }
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: 'ul', items: list })
      list = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const bullet = line.match(/^\s*[*-]\s+(.*)$/)
    if (bullet) {
      flushPara()
      list.push(bullet[1])
      continue
    }
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return blocks
}

export function MarkdownLite({
  text,
  className = '',
}: {
  text: string
  className?: string
}) {
  const blocks = toBlocks(text)
  return (
    <div className={`flex flex-col gap-2 text-[13px] leading-relaxed ${className}`}>
      {blocks.map((block, i) =>
        block.type === 'ul' ? (
          <ul key={i} className="ml-4 list-disc space-y-1 marker:text-ink-muted">
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item, `${i}-${j}`)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{renderInline(block.text, `${i}`)}</p>
        ),
      )}
    </div>
  )
}
