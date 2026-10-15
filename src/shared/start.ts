import { fileURLToPath } from "node:url";
import { createSharedServer } from "./server.js";

const publicOrigin = process.env.PUBLIC_ORIGIN;
if (!publicOrigin) throw new Error("Set PUBLIC_ORIGIN to the HTTPS Funnel origin.");
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
const server = createSharedServer({
  publicOrigin,
  staticDirectory: fileURLToPath(new URL("../../dist-ui/", import.meta.url)),
  ...(process.env.INFERENCE_URL ? { inferenceUrl: process.env.INFERENCE_URL } : {}),
  ...(process.env.INFERENCE_API_KEY ? { inferenceApiKey: process.env.INFERENCE_API_KEY } : {}),
});
server.listen(port, "127.0.0.1", () => console.info(`Shared workout builder listening on 127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close());
