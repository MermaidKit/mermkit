import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = join(root, "bindings", "python");
const python = process.env.PYTHON ?? "python3";

const bootstrap = spawnSync(python, ["-m", "pip", "install", "--upgrade", "build", "twine"], { cwd, stdio: "inherit" });
if (bootstrap.status !== 0) process.exit(bootstrap.status ?? 1);

const build = spawnSync(python, ["-m", "build"], { cwd, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const upload = spawnSync(python, ["-m", "twine", "upload", "dist/*"], { cwd, stdio: "inherit" });
if (upload.status !== 0) process.exit(upload.status ?? 1);
