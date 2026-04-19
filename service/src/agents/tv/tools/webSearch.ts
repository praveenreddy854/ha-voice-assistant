import { z } from "zod";
import { TvToolDefinition, ToolExecutionResult } from "./types";

export const inputSchema = z.object({
  query: z.string().describe(
    "Search query (e.g., 'apple tv remote send_command', 'media_player services') or a component name (e.g., 'apple_tv', 'samsung_tv') to browse its source code on GitHub."
  ),
  url: z.string().url().optional().describe(
    "Optional: A direct URL to fetch. Allowed domains: home-assistant.io and github.com/home-assistant/core."
  ),
  reason: z.string().describe(
    "Why you need this — should reference the failed command (e.g., 'launch_app failed with invalid service, need correct service call')."
  ),
});

export type WebSearchInput = z.infer<typeof inputSchema>;

// ============================================================================
// Constants & helpers
// ============================================================================

const HA_DOMAIN = "home-assistant.io";
const HA_GITHUB_REPO = "home-assistant/core";
const HA_GITHUB_COMPONENTS_PATH = "homeassistant/components";
const MAX_CONTENT_LENGTH = 6000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isHaDomain(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === `www.${HA_DOMAIN}` || parsed.hostname === HA_DOMAIN;
  } catch {
    return false;
  }
}

function isHaGithubRepo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "github.com" &&
      parsed.pathname.startsWith(`/${HA_GITHUB_REPO}`)
    );
  } catch {
    return false;
  }
}

function isAllowedUrl(url: string): boolean {
  return isHaDomain(url) || isHaGithubRepo(url);
}

// ============================================================================
// DuckDuckGo search
// ============================================================================

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDdgResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultBlocks = html.split(/class="result\s/);

  for (const block of resultBlocks.slice(1, 8)) {
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    if (urlMatch?.[1]) {
      let url = urlMatch[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch?.[1]) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      if (isHaDomain(url)) {
        results.push({
          title: titleMatch?.[1]?.trim() || url,
          url,
          snippet: snippetMatch?.[1] ? stripHtml(snippetMatch[1]).substring(0, 200) : "",
        });
      }
    }
  }

  return results;
}

// ============================================================================
// HA docs fetching
// ============================================================================

async function fetchHaPage(url: string): Promise<{ content: string; title: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; HAVoiceAssistant/1.0)",
      "Accept": "text/html",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() || url;

  let content = html;
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (mainMatch?.[1]) {
    content = mainMatch[1];
  } else if (articleMatch?.[1]) {
    content = articleMatch[1];
  }

  const text = stripHtml(content);
  return { content: text.substring(0, MAX_CONTENT_LENGTH), title };
}

// ============================================================================
// GitHub API helpers
// ============================================================================

interface GitHubContentItem {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

const GITHUB_FETCH_HEADERS = {
  "User-Agent": "HAVoiceAssistant/1.0",
  "Accept": "application/vnd.github.v3+json",
};

async function listGitHubComponentDir(componentPath: string): Promise<string> {
  const apiPath = `${HA_GITHUB_COMPONENTS_PATH}/${componentPath}`.replace(/\/+$/, "");
  const apiUrl = `https://api.github.com/repos/${HA_GITHUB_REPO}/contents/${apiPath}?ref=dev`;

  const response = await fetch(apiUrl, {
    headers: GITHUB_FETCH_HEADERS,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${response.statusText}`);
  }

  const items: GitHubContentItem[] = await response.json() as GitHubContentItem[];

  const listing = items
    .map((item) => `${item.type === "dir" ? "📁" : "📄"} ${item.name}${item.size ? ` (${item.size}B)` : ""}`)
    .join("\n");

  return `Directory: ${apiPath}\n\n${listing}`;
}

async function fetchGitHubFile(filePath: string): Promise<string> {
  const rawUrl = `https://raw.githubusercontent.com/${HA_GITHUB_REPO}/dev/${filePath}`;

  const response = await fetch(rawUrl, {
    headers: { "User-Agent": "HAVoiceAssistant/1.0" },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`GitHub raw ${response.status}: ${response.statusText}`);
  }

  const text = await response.text();
  return text.substring(0, MAX_CONTENT_LENGTH);
}

async function fetchGitHubContent(input: string): Promise<string> {
  let componentPath: string;

  if (input.startsWith("http")) {
    const match = input.match(/homeassistant\/components\/(.+)/);
    if (!match?.[1]) {
      throw new Error(
        `URL must point to a path under homeassistant/components/. Got: ${input}`
      );
    }
    componentPath = match[1].replace(/^tree\/dev\//, "");
  } else {
    componentPath = input.replace(/^\/+|\/+$/g, "");
  }

  if (/\.\w+$/.test(componentPath)) {
    const fullPath = `${HA_GITHUB_COMPONENTS_PATH}/${componentPath}`;
    const content = await fetchGitHubFile(fullPath);
    return `📄 File: ${fullPath}\n\n${content}`;
  }

  const dirListing = await listGitHubComponentDir(componentPath);
  let servicesContent = "";

  try {
    const servicesPath = `${HA_GITHUB_COMPONENTS_PATH}/${componentPath}/services.yaml`;
    const services = await fetchGitHubFile(servicesPath);
    servicesContent = `\n\n--- services.yaml ---\n${services}`;
  } catch {
    // No services.yaml — that's fine
  }

  return `${dirListing}${servicesContent}`;
}

// ============================================================================
// Main executor
// ============================================================================

async function execute(
  args: WebSearchInput
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);

  try {
    // Direct URL fetch
    if (parsed.url) {
      if (!isAllowedUrl(parsed.url)) {
        return {
          observation:
            `URL "${parsed.url}" is not allowed. Only home-assistant.io and ` +
            `github.com/${HA_GITHUB_REPO} URLs are accessible.`,
          needsScreenshot: false,
          toolSuccess: false,
        };
      }

      if (isHaGithubRepo(parsed.url)) {
        const content = await fetchGitHubContent(parsed.url);
        return {
          observation: `🔗 GitHub: ${parsed.url}\n\n${content}`,
          needsScreenshot: false,
          toolSuccess: true,
        };
      }

      const { content, title } = await fetchHaPage(parsed.url);
      return {
        observation: `📄 Fetched: ${title}\n🔗 URL: ${parsed.url}\n\n${content}`,
        needsScreenshot: false,
        toolSuccess: true,
      };
    }

    // Component name query — try GitHub first
    const isComponentQuery = /^[a-z_]+$/.test(parsed.query.trim()) && parsed.query.trim().length < 40;
    if (isComponentQuery) {
      try {
        const ghContent = await fetchGitHubContent(parsed.query.trim());
        return {
          observation: `🔍 GitHub component lookup for "${parsed.query}":\n\n${ghContent}`,
          needsScreenshot: false,
          toolSuccess: true,
        };
      } catch {
        // Fall through to web search
      }
    }

    // Search via DuckDuckGo HTML with site restriction
    const searchQuery = `site:${HA_DOMAIN} ${parsed.query}`;
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;

    const searchResponse = await fetch(ddgUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HAVoiceAssistant/1.0)",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!searchResponse.ok) {
      throw new Error(`Search request failed: HTTP ${searchResponse.status}`);
    }

    const searchHtml = await searchResponse.text();
    const results = parseDdgResults(searchHtml);

    if (results.length === 0) {
      return {
        observation:
          `🔍 No results found for "${parsed.query}" on ${HA_DOMAIN}.\n` +
          `Try a different query, a direct URL, or search the GitHub component code ` +
          `(e.g. query "apple_tv" to browse that component's source).`,
        needsScreenshot: false,
        toolSuccess: true,
      };
    }

    let topResultContent = "";
    try {
      const { content, title } = await fetchHaPage(results[0].url);
      topResultContent = `\n\n--- Top Result Content ---\n📄 ${title}\n${content}`;
    } catch {
      // If fetch fails, just show search results
    }

    const resultsList = results
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");

    return {
      observation:
        `🔍 Search results for "${parsed.query}" on ${HA_DOMAIN}:\n\n` +
        `${resultsList}` +
        `${topResultContent}`,
      needsScreenshot: false,
      toolSuccess: true,
    };
  } catch (error) {
    return {
      observation: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }
}

export const definition: TvToolDefinition = {
  name: "web_search",
  description:
    "Search Home Assistant documentation and source code. ONLY use this tool when a command fails and you need to find the correct service call, entity attributes, or integration API. Searches home-assistant.io docs and the HA core GitHub repo (github.com/home-assistant/core). If query is a component name like 'apple_tv', it auto-fetches the component directory listing and services.yaml from GitHub.",
  inputSchema,
  execute,
};
