import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// web3.js, a Squads SDK e o Anchor usam Buffer/process do Node.
// BASE=/demo/ ao empacotar o painel dentro do site t3sa.com (servido em /demo e demo.t3sa.com).
export default defineConfig({
  base: process.env.BASE ?? "/",
  plugins: [react(), nodePolyfills({ include: ["buffer", "process"], globals: { Buffer: true, process: true } })],
  build: { chunkSizeWarningLimit: 2000 },
});
