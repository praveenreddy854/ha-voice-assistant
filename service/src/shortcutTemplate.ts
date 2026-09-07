const BASE_URL_PLACEHOLDER = "__APPLE_SHORTCUT_BASE_URL__";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function placeholderOffsets(value: string): number[] {
  const offsets: number[] = [];
  let offset = value.indexOf(BASE_URL_PLACEHOLDER);
  while (offset !== -1) {
    offsets.push(offset);
    offset = value.indexOf(
      BASE_URL_PLACEHOLDER,
      offset + BASE_URL_PLACEHOLDER.length
    );
  }
  return offsets;
}

function shiftAttachmentRanges(
  tokenString: string,
  attachmentsByRange: JsonObject,
  baseUrl: string
): JsonObject {
  const offsets = placeholderOffsets(tokenString);
  const lengthDelta = baseUrl.length - BASE_URL_PLACEHOLDER.length;
  const shifted: JsonObject = {};

  for (const [range, attachment] of Object.entries(attachmentsByRange)) {
    const match = /^\{(\d+),\s*(\d+)\}$/.exec(range);
    if (!match) {
      throw new Error(`Invalid Shortcut attachment range: ${range}`);
    }

    const start = Number(match[1]);
    const length = Number(match[2]);
    const precedingPlaceholders = offsets.filter(
      (placeholderOffset) => placeholderOffset < start
    ).length;
    const shiftedRange = `{${start + precedingPlaceholders * lengthDelta}, ${length}}`;
    if (shiftedRange in shifted) {
      throw new Error(`Duplicate Shortcut attachment range: ${shiftedRange}`);
    }
    shifted[shiftedRange] = attachment;
  }

  return shifted;
}

function injectBaseUrl(value: unknown, baseUrl: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => injectBaseUrl(entry, baseUrl));
    return;
  }
  if (!isJsonObject(value)) return;

  const tokenString = value.string;
  if (
    typeof tokenString === "string" &&
    tokenString.includes(BASE_URL_PLACEHOLDER) &&
    isJsonObject(value.attachmentsByRange)
  ) {
    value.attachmentsByRange = shiftAttachmentRanges(
      tokenString,
      value.attachmentsByRange,
      baseUrl
    );
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      value[key] = child.split(BASE_URL_PLACEHOLDER).join(baseUrl);
    } else {
      injectBaseUrl(child, baseUrl);
    }
  }
}

export function renderAppleShortcutTemplate(
  source: string,
  baseUrl: string
): string {
  if (!source.includes(BASE_URL_PLACEHOLDER)) {
    throw new Error(`Shortcut template is missing ${BASE_URL_PLACEHOLDER}.`);
  }

  const shortcut: unknown = JSON.parse(source);
  injectBaseUrl(shortcut, baseUrl);
  const rendered = `${JSON.stringify(shortcut, null, 2)}\n`;
  if (rendered.includes("__APPLE_SHORTCUT_")) {
    throw new Error("An unresolved Apple Shortcut placeholder remains.");
  }
  return rendered;
}
