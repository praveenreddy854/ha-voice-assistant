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

// Copy skill .md files (preserving directory structure)
const skillsSrcDir = path.join(__dirname, "..", "src", "agents", "tv", "skills");
const skillsDestDir = path.join(__dirname, "..", "dist", "agents", "tv", "skills");

function copySkillsRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copySkillsRecursive(srcPath, destPath);
    } else if (entry.name.endsWith(".md")) {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

const skillsCopied = copySkillsRecursive(skillsSrcDir, skillsDestDir);
if (skillsCopied > 0) {
  console.log(`Copied ${skillsCopied} skill file(s) to ${skillsDestDir}`);
}

// Also copy trace viewer HTML
const traceViewerSrc = path.join(__dirname, "..", "src", "tracing", "traceViewer.html");
const traceViewerDest = path.join(__dirname, "..", "dist", "tracing", "traceViewer.html");
if (fs.existsSync(traceViewerSrc)) {
  fs.mkdirSync(path.dirname(traceViewerDest), { recursive: true });
  fs.copyFileSync(traceViewerSrc, traceViewerDest);
  console.log("Copied traceViewer.html to dist/tracing/");
}

// Also copy telemetry dashboard HTML
const dashboardViewerSrc = path.join(__dirname, "..", "src", "tracing", "dashboardViewer.html");
const dashboardViewerDest = path.join(__dirname, "..", "dist", "tracing", "dashboardViewer.html");
if (fs.existsSync(dashboardViewerSrc)) {
  fs.mkdirSync(path.dirname(dashboardViewerDest), { recursive: true });
  fs.copyFileSync(dashboardViewerSrc, dashboardViewerDest);
  console.log("Copied dashboardViewer.html to dist/tracing/");
}
