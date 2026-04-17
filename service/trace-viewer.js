#!/usr/bin/env node
/**
 * Service Telemetry Viewer
 * Simple utility to view and analyze persisted service telemetry
 */

const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");
const TELEMETRY_FILE_PATTERN = /^service-telemetry-\d{4}-\d{2}\.jsonl$/;

function readTraces() {
  if (!fs.existsSync(LOG_DIR)) {
    console.log("❌ No telemetry log directory found at:", LOG_DIR);
    return [];
  }

  const files = fs.readdirSync(LOG_DIR)
    .filter((filename) => TELEMETRY_FILE_PATTERN.test(filename))
    .sort();

  if (files.length === 0) {
    console.log("❌ No monthly telemetry files found in:", LOG_DIR);
    return [];
  }

  const lines = files.flatMap((filename) => {
    const content = fs.readFileSync(path.join(LOG_DIR, filename), "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0);
  });

  return lines
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        console.warn(`⚠️  Failed to parse line ${index + 1}:`, error.message);
        return null;
      }
    })
    .filter((trace) => trace !== null);
}

function formatDuration(durationNs) {
  const [seconds, nanoseconds] = durationNs;
  const totalMs = seconds * 1000 + nanoseconds / 1000000;
  return totalMs.toFixed(2) + "ms";
}

function displayTraceSummary(traces) {
  console.log("\n📊 Service Telemetry Summary\n");
  console.log(`Total Traces: ${traces.length}`);

  const operations = {};
  traces.forEach((trace) => {
    operations[trace.name] = (operations[trace.name] || 0) + 1;
  });

  console.log("\nOperations:");
  Object.entries(operations).forEach(([name, count]) => {
    console.log(`  ${name}: ${count}`);
  });

  console.log("\nTime Range:");
  if (traces.length > 0) {
    const timestamps = traces.map((t) => new Date(t.timestamp));
    const earliest = new Date(Math.min(...timestamps));
    const latest = new Date(Math.max(...timestamps));
    console.log(`  From: ${earliest.toISOString()}`);
    console.log(`  To: ${latest.toISOString()}`);
  }
}

function displayPrompts(traces) {
  console.log("\n📝 Prompts and Responses\n");

  traces.forEach((trace, index) => {
    const promptEvents =
      trace.events?.filter((e) => e.name === "prompt.input") || [];
    const responseEvents =
      trace.events?.filter((e) => e.name === "response.output") || [];

    if (promptEvents.length > 0 || responseEvents.length > 0) {
      console.log(`\n🔍 Trace ${index + 1}: ${trace.name}`);
      console.log(`   Trace ID: ${trace.traceId}`);
      console.log(`   Duration: ${formatDuration(trace.duration)}`);
      console.log(
        `   Status: ${trace.status.code === 1 ? "✅ OK" : "❌ ERROR"}`
      );

      promptEvents.forEach((event, i) => {
        const content = event.attributes["prompt.content"] || "";
        const type = event.attributes["prompt.type"] || "unknown";
        console.log(`\n   📥 Prompt ${i + 1} (${type}):`);
        console.log(
          `   ${content.substring(0, 200)}${content.length > 200 ? "..." : ""}`
        );
      });

      responseEvents.forEach((event, i) => {
        const content = event.attributes["response.content"] || "";
        const type = event.attributes["response.type"] || "unknown";
        console.log(`\n   📤 Response ${i + 1} (${type}):`);
        console.log(
          `   ${content.substring(0, 200)}${content.length > 200 ? "..." : ""}`
        );
      });

      console.log("\n   " + "─".repeat(80));
    }
  });
}

function displayErrors(traces) {
  const errorTraces = traces.filter((t) => t.status.code !== 1);

  if (errorTraces.length === 0) {
    console.log("\n✅ No errors found in traces");
    return;
  }

  console.log("\n❌ Error Traces\n");

  errorTraces.forEach((trace, index) => {
    console.log(`\nError ${index + 1}: ${trace.name}`);
    console.log(`  Trace ID: ${trace.traceId}`);
    console.log(`  Message: ${trace.status.message || "Unknown error"}`);
    console.log(`  Duration: ${formatDuration(trace.duration)}`);
  });
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "summary";

  console.log("🔍 Service Telemetry Viewer\n");

  const traces = readTraces();

  if (traces.length === 0) {
    console.log(
      "📭 No traces found. Run some TV Agent operations to generate traces."
    );
    return;
  }

  switch (command) {
    case "summary":
      displayTraceSummary(traces);
      break;
    case "prompts":
      displayPrompts(traces);
      break;
    case "errors":
      displayErrors(traces);
      break;
    case "all":
      displayTraceSummary(traces);
      displayPrompts(traces);
      displayErrors(traces);
      break;
    default:
      console.log("Usage: node trace-viewer.js [summary|prompts|errors|all]");
      console.log("  summary: Show trace statistics (default)");
      console.log("  prompts: Show prompts and responses");
      console.log("  errors: Show error traces only");
      console.log("  all: Show everything");
  }
}

if (require.main === module) {
  main();
}
