/**
 * Download required ML model files into service/models/.
 * Runs automatically via the `prebuild` and `predev` npm hooks so the
 * gesture detector always has the model it needs without committing the
 * binary to git.
 *
 * Skips download when the file already exists with a plausible size.
 * Override the URL with HAND_LANDMARKER_URL env var if needed.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const MIN_BYTES = 1_000_000; // sanity floor; partial downloads usually small

const MODELS = [
  {
    name: "hand_landmarker.task",
    url:
      process.env.HAND_LANDMARKER_URL ||
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
  },
];

const MODELS_DIR = path.join(__dirname, "..", "models");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const tmp = `${dest}.partial`;
    const file = fs.createWriteStream(tmp);
    client
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlink(tmp, () => {});
          return resolve(download(res.headers.location, dest));
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(tmp, () => {});
          return reject(
            new Error(`HTTP ${res.statusCode} fetching ${url}`)
          );
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close((err) => {
            if (err) return reject(err);
            fs.rename(tmp, dest, (renameErr) => {
              if (renameErr) return reject(renameErr);
              resolve();
            });
          });
        });
      })
      .on("error", (err) => {
        file.close();
        fs.unlink(tmp, () => {});
        reject(err);
      });
  });
}

async function main() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  for (const model of MODELS) {
    const dest = path.join(MODELS_DIR, model.name);
    if (fs.existsSync(dest)) {
      const { size } = fs.statSync(dest);
      if (size >= MIN_BYTES) {
        console.log(
          `[models] ${model.name} already present (${size} bytes), skipping`
        );
        continue;
      }
      console.log(
        `[models] ${model.name} exists but is too small (${size} bytes), re-downloading`
      );
      fs.unlinkSync(dest);
    }
    console.log(`[models] downloading ${model.name} from ${model.url}`);
    await download(model.url, dest);
    const { size } = fs.statSync(dest);
    console.log(`[models] ${model.name} ready (${size} bytes)`);
  }
}

main().catch((err) => {
  console.error(`[models] download failed: ${err.message}`);
  process.exit(1);
});
