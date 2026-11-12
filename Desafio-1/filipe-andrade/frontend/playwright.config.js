import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4174'

export default defineConfig({
  testDir: './tests',
  use: { baseURL, channel: 'msedge' },
  webServer: {
    command: 'npm run build && npm exec -- vite preview --host 127.0.0.1 --port 4174 --strictPort',
    url: baseURL,
  },
})
