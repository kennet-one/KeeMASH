import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.DRAGGABLE_DEBUG": "false",
  },
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/target/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
