import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The package is linked from the repo root; make sure it and the app share
  // one React (a second copy breaks hooks with "Invalid hook call").
  resolve: { dedupe: ['react', 'react-dom'] },
});
