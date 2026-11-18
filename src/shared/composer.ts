/**
 * Message box helpers: `@file` mentions and pasted images (pure, tested).
 */
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BASE64_LENGTH, type ImageMediaType, type MessageImage } from './domain'

/** The `@query` being typed right before the caret, if any. */
export function findMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@"]*)$/.exec(before)
  if (!match) return null
  return { start: before.length - (match[2] as string).length - 1, query: match[2] as string }
}

/** Replaces the `@query` at `start…caret` by the mention of `path` (quoted when it holds spaces). */
export function insertMention(text: string, start: number, caret: number, path: string): { text: string; caret: number } {
  const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`
  const after = text.slice(caret)
  const spacer = after.startsWith(' ') ? '' : ' '
  const next = `${text.slice(0, start)}${mention}${spacer}${after}`
  return { text: next, caret: start + mention.length + spacer.length }
}

/** `data:image/png;base64,AAAA` → the image Claude accepts, or why it is refused. */
export function imageFromDataUrl(dataUrl: string): { ok: true; image: MessageImage } | { ok: false; error: string } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) return { ok: false, error: 'image illisible' }
  const mediaType = (match[1] as string).toLowerCase()
  if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) return { ok: false, error: `format non pris en charge (${mediaType}) : PNG, JPEG, GIF ou WebP` }
  const data = match[2] as string
  if (data.length > MAX_IMAGE_BASE64_LENGTH) return { ok: false, error: 'image trop lourde (5 Mo au plus)' }
  return { ok: true, image: { mediaType: mediaType as ImageMediaType, data } }
}
