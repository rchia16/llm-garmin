import { defineConfig } from "vite";
import { handleGb10Start, handleGb10Status } from "./src/local/gb10Control.js";
import { createGarminHandler } from "./src/local/garminControl.js";
import { createGarminAuth } from "./src/local/garminAuth.js";

function gb10Control() {
  const garmin = createGarminHandler(undefined, createGarminAuth());
  const middleware = (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, next: () => void): void => {
    const path = request.url?.split("?")[0];
    if (path === "/api/local/gb10/start") void handleGb10Start(request, response);
    else if (path === "/api/local/gb10/status") void handleGb10Status(request, response);
    else if (path === "/api/local/garmin/status") void garmin(request, response, "status");
    else if (path === "/api/local/garmin/send") void garmin(request, response, "send");
    else if (path === "/api/local/garmin/login") void garmin(request, response, "login");
    else if (path === "/api/local/garmin/mfa") void garmin(request, response, "mfa");
    else if (path === "/api/local/garmin/cancel") void garmin(request, response, "cancel");
    else if (path === "/api/local/garmin/logout") void garmin(request, response, "logout");
    else next();
  };
  return {
    name: "local-gb10-control",
    configureServer(server: import("vite").ViteDevServer) { server.middlewares.use(middleware); },
    configurePreviewServer(server: import("vite").PreviewServer) { server.middlewares.use(middleware); },
  };
}

export default defineConfig({
  plugins: [gb10Control()],
  // Keep one stable browser origin for localStorage and fail instead of silently
  // moving to another port where the user may see a different app/profile.
  server: { host: "localhost", port: 5173, strictPort: true },
  preview: { host: "localhost", port: 4173, strictPort: true },
  build: {
    outDir: "dist-ui",
    emptyOutDir: true,
  },
});
