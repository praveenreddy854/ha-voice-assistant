import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorDetails } from "../src/logSanitizer";

test("redacts raw, transmitted and URL-encoded Foundry credentials in both regions", t => {
  for (const region of ["EUS", "EUS2"]) {
    const key = `${region}/key+abc`;
    const resource = `${region}-Test-Resource`;
    const rawKey = `  ${key}  `;
    const rawResource = `  ${resource}  `;
    for (const [name, value] of [
      [`AZURE_OPENAI_API_KEY_${region}`, rawKey],
      [`AZURE_OPENAI_RESOURCE_NAME_${region}`, rawResource],
    ]) {
      const previous = process.env[name];
      process.env[name] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      });
    }
    const values = [
      rawKey, key, encodeURIComponent(rawKey), encodeURIComponent(key),
      rawResource, resource, encodeURIComponent(rawResource),
    ];
    const hostname = `${resource.toLowerCase()}.openai.azure.com`;
    const error = {
      message: `Failed: ${values.join("|")}|https://${hostname}/openai`,
      statusCode: 401,
    };
    assert.deepEqual(safeErrorDetails(error), {
      message: `Failed: ${values.map(() => "[REDACTED]").join("|")}|https://[REDACTED].openai.azure.com/openai`,
      statusCode: 401,
    });
  }
});
