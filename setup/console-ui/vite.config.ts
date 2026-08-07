import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// console-ui 由 setup/console-server.cjs 静态 serve 到根路径 /。
// base: "./" 使产物用相对路径，便于未来挂到 /console 子路径。
// 开发模式 proxy /api 到 console-server（默认 7677）。
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7677",
        changeOrigin: false,
      },
    },
  },
});
