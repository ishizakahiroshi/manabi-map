import { createPublicationIntakeHandler } from './handler.ts'

// Keep the caller identity for auth.uid() and admin authorization. No deploy hook.
Deno.serve(createPublicationIntakeHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL'),
  anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
}))
