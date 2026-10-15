import { fileURLToPath } from "node:url";
import { createSharedServer } from "./server.js";
import { join } from "node:path";
import { hostedDataDirectory } from "./config.js";
import { AccountStore } from "./accounts.js";
import { HostedApi } from "./hostedApi.js";
import { UserGarmin } from "./garmin.js";

const publicOrigin = process.env.PUBLIC_ORIGIN;
if (!publicOrigin) throw new Error("Set PUBLIC_ORIGIN to the HTTPS Funnel origin.");
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
const dataDirectory = hostedDataDirectory();
const store = new AccountStore(join(dataDirectory, "accounts.sqlite"));
const hosted = new HostedApi(store, new UserGarmin(dataDirectory), publicOrigin);
const server = createSharedServer({
  hosted,
  publicOrigin,
  staticDirectory: fileURLToPath(new URL("../../dist-ui/", import.meta.url)),
  ...(process.env.INFERENCE_URL ? { inferenceUrl: process.env.INFERENCE_URL } : {}),
  ...(process.env.INFERENCE_API_KEY ? { inferenceApiKey: process.env.INFERENCE_API_KEY } : {}),
});
server.listen(port, "127.0.0.1", () => console.info(`Shared workout builder listening on 127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  hosted.close();
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();
});
