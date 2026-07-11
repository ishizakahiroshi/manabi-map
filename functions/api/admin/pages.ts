import { ranked } from './_ranked'
import type { Context } from './_auth'
export const onRequestGet = (context: Context) => ranked(context, 'dash_gsc_pages', 'page')
