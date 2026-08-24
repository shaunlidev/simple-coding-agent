import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else if (path.includes(`${join("dist", "")}`) && !path.endsWith(".tsbuildinfo")) {
      files.push(path);
    }
  }
  return files;
}

const files = await collectFiles("packages");
const offenders = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  if (text.includes("../../ai/src") || text.includes("../../agent/src") || text.includes("../../coding-agent/src")) {
    offenders.push(file);
  }
}

if (offenders.length > 0) {
  console.error(`Built package files import source paths:\n${offenders.join("\n")}`);
  process.exitCode = 1;
}
