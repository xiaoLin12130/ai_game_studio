/**
 * Attachments: what the runtime can actually take, and what has to be converted first.
 *
 * The SDK accepts text blocks and inline images (png/jpeg/webp/gif). It does not accept a
 * PDF or a DOCX. Pretending otherwise would mean building a prompt the runtime rejects, so
 * documents are extracted to text here and the loss is recorded rather than hidden.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { AttachmentKind, AttachmentRecord } from './types'
import { assertInsideProject } from '../projects/paths'
import type { RequirementStore } from './store'

/** MIME types the SDK accepts as inline image blocks. */
export const INLINE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

const TEXT_MIMES = ['text/plain', 'text/markdown', 'application/json', 'text/csv']
const DOCUMENT_MIMES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']

/** How much text one document may contribute. */
const MAX_EXTRACTED = 60000

/**
 * Read one file out of a ZIP container.
 *
 * Node ships zlib, so no dependency is needed: walk the central directory, find the entry,
 * and inflate it. Both stored (method 0) and deflated (method 8) entries are handled, because
 * a Word document may use either.
 */
export function readZipEntry(zip: Buffer, entryName: string): string | null {
  try {
    // The end-of-central-directory record sits at the tail, after an optional comment.
    let eocd = -1
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i -= 1) {
      if (zip.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null

    const entries = zip.readUInt16LE(eocd + 10)
    let offset = zip.readUInt32LE(eocd + 16)

    for (let i = 0; i < entries; i += 1) {
      if (offset + 46 > zip.length) return null
      if (zip.readUInt32LE(offset) !== 0x02014b50) return null

      const method = zip.readUInt16LE(offset + 10)
      const compressedSize = zip.readUInt32LE(offset + 20)
      const nameLength = zip.readUInt16LE(offset + 28)
      const extraLength = zip.readUInt16LE(offset + 30)
      const commentLength = zip.readUInt16LE(offset + 32)
      const localOffset = zip.readUInt32LE(offset + 42)
      const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)

      if (name === entryName) {
        if (localOffset + 30 > zip.length) return null
        const localNameLength = zip.readUInt16LE(localOffset + 26)
        const localExtraLength = zip.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + localNameLength + localExtraLength
        const data = zip.subarray(dataStart, dataStart + compressedSize)
        if (method === 0) return data.toString('utf8')
        if (method === 8) return zlib.inflateRawSync(data).toString('utf8')
        return null
      }
      offset += 46 + nameLength + extraLength + commentLength
    }
    return null
  } catch {
    return null
  }
}

/**
 * Decode the body of a Word document into text.
 *
 * Runs are visited in document order together with paragraph ends, because a paragraph break
 * lives outside the <w:t> elements: extracting runs first and then looking for paragraphs
 * finds none, since the first pass already rewrote them.
 */
export function documentXmlToText(xml: string): string {
  const parts: string[] = []
  let paragraphs = 0

  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>/g)) {
    const token = match[0]
    if (token === '</w:p>') {
      parts.push('\n')
      paragraphs += 1
      continue
    }
    if (token.startsWith('<w:tab')) {
      parts.push('\t')
      continue
    }
    if (token.startsWith('<w:br')) {
      parts.push('\n')
      continue
    }
    parts.push(decodeXmlEntities(match[1] ?? ''))
  }

  if (paragraphs === 0 && parts.length === 0) return ''

  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

export interface AttachmentFailure {
  ok: false
  code: 'UNSUPPORTED' | 'TOO_LARGE' | 'UNREADABLE' | 'EXTRACTION_FAILED' | 'ESCAPES_PROJECT'
  detail: string
}

export interface AttachmentSuccess {
  ok: true
  attachment: AttachmentRecord
  /** True when the runtime can take this file directly; false when text was extracted. */
  inline: boolean
}

export type AttachmentResult = AttachmentSuccess | AttachmentFailure

export function classify(mime: string): AttachmentKind {
  if ((INLINE_IMAGE_MIMES as readonly string[]).includes(mime)) return 'image'
  if (TEXT_MIMES.includes(mime)) return 'text'
  if (DOCUMENT_MIMES.includes(mime)) return 'document'
  return 'unsupported'
}

/**
 * Extract text from a document.
 *
 * PDF and DOCX are both zip/stream formats; a full parser is out of scope for this phase, so
 * this does the honest minimum: pull readable text runs out of the bytes and say so. A file
 * that yields nothing is reported as a failure rather than stored as an empty attachment.
 */
export function extractText(buffer: Buffer, mime: string): { text: string | null; note: string } {
  if (TEXT_MIMES.includes(mime)) {
    return { text: buffer.toString('utf8').slice(0, MAX_EXTRACTED), note: 'plain text' }
  }
  if (mime === 'application/pdf') {
    // PDF text lives in stream objects; pull the printable runs between BT/ET markers.
    const raw = buffer.toString('latin1')
    const runs = [...raw.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)].map((m) => m[1])
    const text = runs.join(' ').replace(/\\([()\\])/g, '$1').trim()
    if (text.length === 0) {
      return { text: null, note: 'PDF 未提取到文本（可能是扫描件或纯图片 PDF）' }
    }
    return { text: text.slice(0, MAX_EXTRACTED), note: 'PDF 文本层提取，版式与图片丢失' }
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    // A DOCX is a ZIP whose text lives in word/document.xml, deflated. Reading the bytes as
    // UTF-8 finds nothing, because the content is compressed — the earlier implementation
    // did exactly that and reported every standard DOCX as unreadable.
    const xml = readZipEntry(buffer, 'word/document.xml')
    if (!xml) {
      return { text: null, note: 'DOCX 中找不到 word/document.xml（文件可能损坏或不是 Word 文档）' }
    }
    const text = documentXmlToText(xml)
    if (text.length === 0) {
      return { text: null, note: 'DOCX 正文为空' }
    }
    return { text: text.slice(0, MAX_EXTRACTED), note: 'DOCX 文本提取，样式、图片与表格排版丢失' }
  }
  return { text: null, note: '该格式不支持文本提取' }
}

export interface AttachmentServiceOptions {
  store: RequirementStore
  /** Root of the app's per-project data, where attachments are stored. */
  dataDir: string
  maxBytes?: number
}

export class AttachmentService {
  readonly #store: RequirementStore
  readonly #dataDir: string
  readonly #maxBytes: number

  constructor(options: AttachmentServiceOptions) {
    this.#store = options.store
    this.#dataDir = options.dataDir
    this.#maxBytes = options.maxBytes ?? 20 * 1024 * 1024
  }

  /** Where this project's attachments live. Inside the app's data dir, not the game folder. */
  dirFor(projectId: string): string {
    return path.join(this.#dataDir, projectId, 'attachments')
  }

  /**
   * Store one attachment.
   *
   * The bytes are written under the project's own directory and the path is checked against
   * it, so a crafted filename cannot land outside.
   */
  add(input: {
    projectId: string
    conversationId?: string | null
    filename: string
    mime: string
    buffer: Buffer
  }): AttachmentResult {
    if (input.buffer.length > this.#maxBytes) {
      return { ok: false, code: 'TOO_LARGE', detail: '文件超过 ' + Math.round(this.#maxBytes / 1024 / 1024) + ' MB 上限。' }
    }
    const kind = classify(input.mime)
    if (kind === 'unsupported') {
      return { ok: false, code: 'UNSUPPORTED', detail: '不支持的文件类型：' + input.mime + '。支持 PNG/JPEG/WebP/GIF、TXT/MD/JSON/CSV、PDF、DOCX。' }
    }

    const dir = this.dirFor(input.projectId)
    fs.mkdirSync(dir, { recursive: true })
    const sha256 = crypto.createHash('sha256').update(input.buffer).digest('hex')
    // The stored name is derived from the hash, never from the user's filename: a filename
    // is display data, not a path.
    const storedName = sha256.slice(0, 16) + path.extname(input.filename).slice(0, 12)
    const storedPath = path.join(dir, storedName)
    try {
      assertInsideProject(dir, storedPath)
    } catch (error) {
      return { ok: false, code: 'ESCAPES_PROJECT', detail: String((error as Error)?.message ?? error) }
    }

    try {
      fs.writeFileSync(storedPath, input.buffer)
    } catch (error) {
      return { ok: false, code: 'UNREADABLE', detail: '无法保存附件：' + String((error as Error)?.message ?? error) }
    }

    const extraction = extractText(input.buffer, input.mime)
    if (kind === 'document' && extraction.text === null) {
      return { ok: false, code: 'EXTRACTION_FAILED', detail: extraction.note }
    }

    const attachment = this.#store.createAttachment({
      projectId: input.projectId,
      conversationId: input.conversationId ?? null,
      filename: input.filename,
      mime: input.mime,
      bytes: input.buffer.length,
      sha256,
      kind,
      extractedText: extraction.text,
      storedPath,
    })
    return { ok: true, attachment, inline: kind === 'image' }
  }

  /** Read the bytes back for an inline image block. Project-scoped. */
  readForInline(projectId: string, attachmentId: string): { ok: true; data: string; mime: string } | AttachmentFailure {
    const attachment = this.#store.getAttachment(projectId, attachmentId)
    if (!attachment) return { ok: false, code: 'UNREADABLE', detail: '附件不存在或不属于该项目。' }
    if (attachment.kind !== 'image') return { ok: false, code: 'UNSUPPORTED', detail: '只有图片可以内联发送。' }
    try {
      const buffer = fs.readFileSync(attachment.storedPath)
      return { ok: true, data: buffer.toString('base64'), mime: attachment.mime }
    } catch (error) {
      return { ok: false, code: 'UNREADABLE', detail: '无法读取附件：' + String((error as Error)?.message ?? error) }
    }
  }

  remove(projectId: string, attachmentId: string): boolean {
    const attachment = this.#store.getAttachment(projectId, attachmentId)
    if (!attachment) return false
    try {
      fs.rmSync(attachment.storedPath, { force: true })
    } catch {
      /* the row is what matters; a leftover file is harmless */
    }
    return this.#store.deleteAttachment(projectId, attachmentId)
  }
}
