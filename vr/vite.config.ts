import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// The VR app only ever talks to the Gate API, so everything it needs is
// proxied through the dev server on one origin — no CORS, and one URL to open
// in the Quest browser.
const GATE = process.env.GATE_API ?? "http://127.0.0.1:8000";
const paths = [
  "/queue",
  "/candidates",
  "/decisions",
  "/experiments",
  "/structures",
  "/config",
  "/health",
  "/scan",
  "/contacts",
  "/variants",
  "/proposals",
  "/bridge",
  "/voice",
];
const proxy = Object.fromEntries(
  paths.map((path) => [path, { target: GATE, changeOrigin: true }]),
);

// WebXR needs a secure context. Over USB (`adb reverse tcp:5173 tcp:5173`)
// http://localhost:5173 already counts as secure, so HTTPS is opt-in for the
// LAN case: HTTPS=1 npm run dev.
const https = process.env.HTTPS === "1";

// A tunnel (cloudflared / ngrok) arrives with a Host header Vite does not
// know, and it rejects those by default: TUNNEL=1 npm run dev to allow them.
const allowedHosts = process.env.TUNNEL === "1" ? true : undefined;

export default defineConfig({
  plugins: https ? [basicSsl()] : [],
  server: { host: true, port: 5173, strictPort: true, proxy, allowedHosts },
  preview: { host: true, port: 5173, proxy },
  build: { target: "es2022" },
});
