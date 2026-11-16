import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks: { graficos: ['recharts'], supabase: ['@supabase/supabase-js'], react: ['react', 'react-dom', 'react-router-dom'] } } },
  },
  server: { port: 5173 },
});
