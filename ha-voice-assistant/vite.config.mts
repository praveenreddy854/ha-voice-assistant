import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";

function mediaPipeUmdExports(): Plugin {
  return {
    name: "mediapipe-umd-exports",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?", 1)[0];
      if (cleanId.endsWith("/@mediapipe/hands/hands.js")) {
        return `${code}\nexport const Hands = globalThis.Hands;\nexport const HAND_CONNECTIONS = globalThis.HAND_CONNECTIONS;\nexport const VERSION = globalThis.VERSION;`;
      }
      if (cleanId.endsWith("/@mediapipe/camera_utils/camera_utils.js")) {
        return `${code}\nexport const Camera = globalThis.Camera;`;
      }
      return null;
    },
  };
}

export default defineConfig({
  envPrefix: ["VITE_", "REACT_APP_"],
  plugins: [mediaPipeUmdExports(), react()],
  optimizeDeps: {
    exclude: ["@mediapipe/hands", "@mediapipe/camera_utils"],
  },
  test: {
    environment: "happy-dom",
    exclude: [...configDefaults.exclude, "e2e/**"],
    globals: true,
    setupFiles: "./src/setupTests.ts",
  },
});
