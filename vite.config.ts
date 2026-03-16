import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['s-mac-mini', 's-mac-mini.tailf4f4d.ts.net'],
  },
})
