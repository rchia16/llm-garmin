import { homedir } from "node:os";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function hostedDataDirectory(): string {
  const configured = process.env.WORKOUT_DATA_DIR;
  if (configured && !isAbsolute(configured)) throw new Error("WORKOUT_DATA_DIR must be absolute.");
  const directory = resolve(configured || join(homedir(), ".local/share/LocalWorkoutBuilder/hosted"));
  const runtime = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const withinRuntime = relative(runtime, directory);
  const runtimeFromData = relative(directory, runtime);
  if (!runtimeFromData.startsWith(".." + sep) && runtimeFromData !== ".." && !isAbsolute(runtimeFromData)) throw new Error("WORKOUT_DATA_DIR must not be an ancestor of the application directory.");
  if (!withinRuntime || (!withinRuntime.startsWith(".." + sep) && withinRuntime !== ".." && !isAbsolute(withinRuntime))) throw new Error("WORKOUT_DATA_DIR must be outside the application directory.");
  for (let ancestor = directory; ; ancestor = resolve(ancestor, "..")) {
    try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error("WORKOUT_DATA_DIR must not contain symlinks."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (resolve(ancestor, "..") === ancestor) break;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error("WORKOUT_DATA_DIR must not contain symlinks.");
  if (process.platform !== "win32") {
    if (lstatSync(directory).uid !== process.getuid?.()) throw new Error("Private data directory must belong to the service account.");
    chmodSync(directory, 0o700);
  }
  return directory;
}
