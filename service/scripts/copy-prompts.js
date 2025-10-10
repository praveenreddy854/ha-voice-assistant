const fs = require("fs");
const path = require("path");

const sourceDir = path.join(__dirname, "..", "src", "prompts");
const targetDir = path.join(__dirname, "..", "dist", "prompts");

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

console.log(`Copied ${promptFiles.length} prompt file(s) to ${targetDir}`);
