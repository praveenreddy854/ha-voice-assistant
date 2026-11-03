import { execFile } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import dotenv from "dotenv";
import { renderAppleShortcutTemplate } from "../src/shortcutTemplate";

const execFileAsync = promisify(execFile);
const serviceRoot = path.resolve(__dirname, "..");
const templatePath = path.join(
  serviceRoot,
  "shortcuts",
  "Ask Assistant.shortcut.json"
);
const outputPath = path.join(
  serviceRoot,
  "dist",
  "shortcuts",
  "Ask Assistant.shortcut"
);

dotenv.config({ path: path.join(serviceRoot, ".env") });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set in service/.env.`);
  return value;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Shortcut packaging requires macOS and the shortcuts CLI.");
  }

  const baseUrl = required("APPLE_SHORTCUT_BASE_URL").replace(/\/+$/, "");
  const template = await readFile(templatePath, "utf8");
  const source = renderAppleShortcutTemplate(template, baseUrl);

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "ha-voice-assistant-shortcut-")
  );
  const jsonPath = path.join(temporaryDirectory, "Ask Assistant.json");
  const unsignedPath = path.join(temporaryDirectory, "Ask Assistant.shortcut");

  try {
    await writeFile(jsonPath, source, { mode: 0o600 });
    await execFileAsync("plutil", [
      "-convert",
      "binary1",
      "-o",
      unsignedPath,
      jsonPath,
    ]);
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await execFileAsync("shortcuts", [
      "sign",
      "--mode",
      "people-who-know-me",
      "--input",
      unsignedPath,
      "--output",
      outputPath,
    ]);
    await chmod(outputPath, 0o600);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(`Packaged Shortcut: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
