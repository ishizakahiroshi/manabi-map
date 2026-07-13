#!/usr/bin/env node
/**
 * Toggle the runtime maintenance flag in Supabase.
 *
 * Usage:
 *   node scripts/maintenance.mjs status
 *   node scripts/maintenance.mjs on
 *   node scripts/maintenance.mjs off
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const command = process.argv[2]
if (!['status', 'on', 'off'].includes(command)) {
  console.error('Usage: node scripts/maintenance.mjs status|on|off')
  process.exitCode = 2
} else {
  try {
    const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '../web/.env.local')
    const fileEnv = parseEnvFile(envFile)
    const supabaseUrl = (fileEnv.SUPABASE_URL ?? fileEnv.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
    const serviceRoleKey = fileEnv.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
    if (!supabaseUrl) throw new Error('SUPABASE_URL (or VITE_SUPABASE_URL) is missing in web/.env.local')
    if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing in web/.env.local')

    const configUrl = `${supabaseUrl}/rest/v1/app_config?key=eq.maintenance_mode&select=key,value,updated_at,updated_by`
    const headers = {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    }
    const current = await request(configUrl, { headers })
    if (!Array.isArray(current) || current.length === 0) throw new Error('maintenance_mode config row was not found')

    if (command === 'status') {
      printState(current[0])
    } else {
      const on = command === 'on'
      const updated = await request(configUrl, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json', prefer: 'return=representation' },
        body: JSON.stringify({ value: { on }, updated_at: new Date().toISOString(), updated_by: null }),
      })
      if (!Array.isArray(updated) || updated.length === 0) throw new Error('maintenance_mode update returned no row')
      printState(updated[0])
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

function parseEnvFile(path) {
  const values = {}
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Could not read ${path}`)
  }
  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

async function request(url, options = {}) {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`)
  return response.json()
}

function printState(row) {
  const on = Boolean(row?.value && row.value.on === true)
  const updatedAt = typeof row?.updated_at === 'string' ? row.updated_at : '—'
  const updatedBy = row?.updated_by ?? 'null'
  console.log(`maintenance_mode: ${on ? 'ON' : 'OFF'} (updated_at: ${updatedAt}, updated_by: ${updatedBy})`)
}
