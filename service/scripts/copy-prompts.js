const fs = require("fs");
const path = require("path");

const sourceDir = path.join(__dirname, "..", "src", "prompts");
const targetDir = path.join(__dirname, "..", "dist", "prompts");
const skillsSourceDir = path.join(__dirname, "..", "src", "skills");
const skillsTargetDir = path.join(__dirname, "..", "dist", "skills");

if (!fs.existsSync(sourceDir)) {
  console.error(`Source prompts directory not found: ${sourceDir}`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

const promptFiles = fs
  .readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
  .map((entry) => entry.name);

if (promptFiles.length === 0) {
  console.warn(`No prompt markdown files found in ${sourceDir}`);
  process.exit(0);
}

for (const filename of promptFiles) {
  const from = path.join(sourceDir, filename);
  const to = path.join(targetDir, filename);
  fs.copyFileSync(from, to);
}

function copyDirectoryRecursive(fromDir, toDir) {
  if (!fs.existsSync(fromDir)) {
    return;
  }

  fs.mkdirSync(toDir, { recursive: true });
  const entries = fs.readdirSync(fromDir, { withFileTypes: true });

  for (const entry of entries) {
    const fromPath = path.join(fromDir, entry.name);
    const toPath = path.join(toDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(fromPath, toPath);
      continue;
    }

    fs.copyFileSync(fromPath, toPath);
  }
}

copyDirectoryRecursive(skillsSourceDir, skillsTargetDir);

console.log(`Copied ${promptFiles.length} prompt file(s) to ${targetDir}`);
console.log(`Copied skills directory to ${skillsTargetDir}`);
