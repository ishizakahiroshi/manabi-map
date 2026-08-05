import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // テストは実際の接続情報に依存させない（hermetic）。
    // src/lib/supabase.ts は VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が無いと
    // import 時点で throw するため、それを import するテスト
    // （AppContext.test.ts / FamilyJoinPage.test.ts 等）は env が無いと suite ごと落ちる。
    // CI（.github/workflows/validate.yml の Test ステップ）は .env.local を持たないので、
    // ここで合成値を与えないと CI が赤になる。値は接続に使われない合成データ。
    env: {
      VITE_SUPABASE_URL: 'https://synthetic-project.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'synthetic-anon-key-for-tests',
    },
  },
})
