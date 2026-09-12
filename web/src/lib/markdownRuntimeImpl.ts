import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MarkdownRuntime } from './markdownRuntime'

/**
 * Markdown 描画器の実体。**このファイルだけが react-markdown を静的 import する。**
 * クライアントでは markdownRuntime.ts の動的 import 経由でしか読まれないので、
 * 初期バンドルへは入らない（plan_legal-guide-markdown-split.md）。
 * SSR（entry-server.tsx）は静的に import して setMarkdownRuntime() する。
 */
export const markdownRuntime: MarkdownRuntime = { Markdown, remarkGfm }
