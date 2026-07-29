import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Укажите имя вашего репозитория со слэшами с обеих сторон:
  base: "https://github.com/n0rg3/spendly", 
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});