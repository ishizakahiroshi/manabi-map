import { mergeConfig } from 'vite'
import base from './vite.config.ts'

// Used only in the isolated workspace prepared by build-school-candidates.mjs.
// site.json there carries the candidate origin; production site.json is untouched.
export default mergeConfig(base, { envDir: false, build: { emptyOutDir: false } })
