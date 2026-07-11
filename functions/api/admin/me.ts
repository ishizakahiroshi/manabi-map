import { json, requireAdmin, type Context } from './_auth'
export const onRequestGet = async (context: Context) => (await requireAdmin(context)) ?? json({ ok: true })
