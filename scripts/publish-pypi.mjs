import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = join(root, "bindings", "python");

if (process.env.CI !== "true") {
  console.error("PyPI publishing is handled by GitHub Actions trusted publishing (OIDC). Run a tagged release instead.");
  process.exit(1);
}

console.log(`PyPI publish is handled in GitHub Actions for ${cwd}.`);
