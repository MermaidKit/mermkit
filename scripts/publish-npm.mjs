import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDir, entry.name));

for (const dir of packageDirs) {
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private) {
    console.log(`skip ${pkg.name} (private)`);
    continue;
  }
  console.log(`publishing ${pkg.name}...`);
  const res = spawnSync("npm", ["publish", "--access", "public", "--provenance"], {
    cwd: dir,
    stdio: "inherit"
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}
