interface Context {
  request: Request
}

const MAX_BODY_BYTES = 32_768
const MAX_SAFE_TEXT_LENGTH = 256
const MAX_SAFE_URL_LENGTH = 2_048

type JsonRecord = Record<string, unknown>

export interface SafeCspReport {
  documentUri?: string
  referrer?: string
  blockedUri?: string
  sourceFile?: string
  violatedDirective?: string
  effectiveDirective?: string
  disposition?: string
  statusCode?: number
  lineNumber?: number
  columnNumber?: number
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstPresent(record: JsonRecord, keys: string[]): { present: boolean; value: unknown } {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return { present: true, value: record[key] }
  }
  return { present: false, value: undefined }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength)
}

function sanitizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.trim()) return ''
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:'].includes(url.protocol)) return null
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return url.protocol
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return truncate(url.toString(), MAX_SAFE_URL_LENGTH)
  } catch {
    return null
  }
}

const SAFE_BLOCKED_URI_VALUES = new Set(['self', 'none', 'inline', 'eval', 'wasm-eval', 'data', 'blob'])

function sanitizeBlockedUri(value: unknown): string | null {
  if (typeof value === 'string' && SAFE_BLOCKED_URI_VALUES.has(value.trim())) return value.trim()
  return sanitizeUrl(value)
}

function sanitizeDirective(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_SAFE_TEXT_LENGTH || !/^[A-Za-z0-9_.:/ -]+$/.test(trimmed)) return null
  return trimmed
}

function sanitizeDisposition(value: unknown): string | null {
  return value === 'report' || value === 'enforce' ? value : null
}

function sanitizeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return null
  return value
}

function reportPayload(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null
  const wrapped = value['csp-report']
  if (wrapped !== undefined) return isRecord(wrapped) ? wrapped : null
  const reportingBody = value.body
  if (isRecord(reportingBody)) return reportingBody
  return value
}

/** CSP report の wrapper 有無を許容し、ログに出してよい値だけを抽出する。 */
export function extractSafeCspReport(value: unknown): SafeCspReport | null {
  const report = reportPayload(value)
  if (!report) return null

  const result: SafeCspReport = {}
  let recognized = 0
  let invalid = false

  const documentUri = firstPresent(report, ['document-uri', 'documentURL', 'document-url', 'url'])
  if (documentUri.present) {
    recognized += 1
    const safe = sanitizeUrl(documentUri.value)
    if (safe === null) invalid = true
    else result.documentUri = safe
  }

  const referrer = firstPresent(report, ['referrer'])
  if (referrer.present) {
    recognized += 1
    const safe = sanitizeUrl(referrer.value)
    if (safe === null) invalid = true
    else result.referrer = safe
  }

  const blockedUri = firstPresent(report, ['blocked-uri', 'blockedURL', 'blocked-url'])
  if (blockedUri.present) {
    recognized += 1
    const safe = sanitizeBlockedUri(blockedUri.value)
    if (safe === null) invalid = true
    else result.blockedUri = safe
  }

  const sourceFile = firstPresent(report, ['source-file', 'sourceFile'])
  if (sourceFile.present) {
    recognized += 1
    const safe = sanitizeUrl(sourceFile.value)
    if (safe === null) invalid = true
    else result.sourceFile = safe
  }

  const violatedDirective = firstPresent(report, ['violated-directive', 'violatedDirective'])
  if (violatedDirective.present) {
    recognized += 1
    const safe = sanitizeDirective(violatedDirective.value)
    if (safe === null) invalid = true
    else result.violatedDirective = safe
  }

  const effectiveDirective = firstPresent(report, ['effective-directive', 'effectiveDirective'])
  if (effectiveDirective.present) {
    recognized += 1
    const safe = sanitizeDirective(effectiveDirective.value)
    if (safe === null) invalid = true
    else result.effectiveDirective = safe
  }

  const disposition = firstPresent(report, ['disposition'])
  if (disposition.present) {
    recognized += 1
    const safe = sanitizeDisposition(disposition.value)
    if (safe === null) invalid = true
    else result.disposition = safe
  }

  const statusCode = firstPresent(report, ['status-code', 'statusCode'])
  if (statusCode.present) {
    recognized += 1
    const safe = sanitizeNumber(statusCode.value, 0, 999)
    if (safe === null) invalid = true
    else result.statusCode = safe
  }

  const lineNumber = firstPresent(report, ['line-number', 'lineNumber'])
  if (lineNumber.present) {
    recognized += 1
    const safe = sanitizeNumber(lineNumber.value, 0, 1_000_000)
    if (safe === null) invalid = true
    else result.lineNumber = safe
  }

  const columnNumber = firstPresent(report, ['column-number', 'columnNumber'])
  if (columnNumber.present) {
    recognized += 1
    const safe = sanitizeNumber(columnNumber.value, 0, 1_000_000)
    if (safe === null) invalid = true
    else result.columnNumber = safe
  }

  if (recognized === 0 || invalid || Object.keys(result).length === 0) return null
  return result
}

function isTooLarge(request: Request, body?: string): boolean {
  const contentLengthHeader = request.headers.get('content-length')
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader)
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return true
  }
  return body !== undefined && new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES
}

/** CSP Report-Only の受け口。本文は上限を設け、実データを保存せず安全な最小値だけログへ出す。 */
export const onRequestPost = async ({ request }: Context): Promise<Response> => {
  if (isTooLarge(request)) return new Response(null, { status: 413 })
  const body = await request.text()
  if (isTooLarge(request, body)) return new Response(null, { status: 413 })
  try {
    const report = extractSafeCspReport(JSON.parse(body) as unknown)
    if (!report) {
      console.warn('csp-report: invalid schema')
      return new Response(null, { status: 204 })
    }
    console.warn('csp-report', JSON.stringify(report))
  } catch {
    console.warn('csp-report: invalid JSON')
  }
  return new Response(null, { status: 204 })
}

export const onRequest = async ({ request }: Context): Promise<Response> => {
  if (request.method === 'POST') return onRequestPost({ request })
  return new Response(null, { status: 405, headers: { allow: 'POST' } })
}
