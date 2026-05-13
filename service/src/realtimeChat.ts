import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import {
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_RESOURCE_NAME,
  AZURE_OPENAI_REALTIME_API_VERSION,
  AI_MODEL_REALTIME,
  USER_ADDRESS,
} from "./config";

// ============================================================================
// Web Search via DuckDuckGo HTML
// ============================================================================

const MAX_CONTENT_LENGTH = 4000;

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

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDdgResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultBlocks = html.split(/class="result\s/);

  for (const block of resultBlocks.slice(1, 6)) {
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    if (urlMatch?.[1]) {
      let url = urlMatch[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch?.[1]) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      results.push({
        title: titleMatch?.[1]?.trim() || url,
        url,
        snippet: snippetMatch?.[1] ? stripHtml(snippetMatch[1]).substring(0, 200) : "",
      });
    }
  }

  return results;
}

async function fetchPageContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HAVoiceAssistant/1.0)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return "";

    const html = await response.text();
    let content = html;
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (mainMatch?.[1]) content = mainMatch[1];
    else if (articleMatch?.[1]) content = articleMatch[1];

    return stripHtml(content).substring(0, MAX_CONTENT_LENGTH);
  } catch {
    return "";
  }
}

async function executeWebSearch(query: string): Promise<string> {
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(ddgUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HAVoiceAssistant/1.0)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return `Search failed: HTTP ${response.status}`;

    const html = await response.text();
    const results = parseDdgResults(html);

    if (results.length === 0) return `No results found for "${query}".`;

    const resultsList = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");

    // Fetch top result content for richer context
    const topContent = await fetchPageContent(results[0].url);
    const topSection = topContent
      ? `\n\n--- Top Result Content (${results[0].title}) ---\n${topContent}`
      : "";

    return `Search results for "${query}":\n\n${resultsList}${topSection}`;
  } catch (error) {
    return `Search error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ============================================================================
// Persistent Azure Realtime Session
// ============================================================================

let azureWs: WebSocket | null = null;
let azureReady = false;
let activeClientWs: WebSocket | null = null;
let fullTranscript = "";

function connectAzure(onReady: () => void): void {
  if (azureWs && azureReady) {
    onReady();
    return;
  }

  // Close stale connection if any
  if (azureWs) {
    azureWs.removeAllListeners();
    if (azureWs.readyState === WebSocket.OPEN || azureWs.readyState === WebSocket.CONNECTING) {
      azureWs.close();
    }
    azureWs = null;
    azureReady = false;
  }

  const azureUrl =
    `wss://${AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/realtime` +
    `?api-version=${AZURE_OPENAI_REALTIME_API_VERSION}` +
    `&deployment=${AI_MODEL_REALTIME}`;

  const ws = new WebSocket(azureUrl, {
    headers: { "api-key": AZURE_OPENAI_API_KEY! },
  });
  azureWs = ws;

  ws.on("open", () => {
    console.log("[RealtimeChat] Connected to Azure Realtime API");

    // Configure the session with web search tool
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        instructions: `You are a helpful home assistant. Be concise and conversational. Keep responses short unless asked for detail. You have a web_search tool — use it when the user asks about current events, facts you're unsure about, or anything that benefits from live information.${USER_ADDRESS ? ` The user's address is: ${USER_ADDRESS}. Use this for location-based queries like weather.` : ""}`,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        turn_detection: null,
        tools: [
          {
            type: "function",
            name: "web_search",
            description: "Search the web for current information. Use when the user asks about recent events, news, facts, weather, or anything that needs up-to-date data.",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The search query",
                },
              },
              required: ["query"],
            },
          },
        ],
      },
    }));

    azureReady = true;
    onReady();
  });

  ws.on("message", async (data) => {
    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case "response.audio.delta":
          activeClientWs?.send(JSON.stringify({
            type: "audio_delta",
            audio: event.delta,
          }));
          break;

        case "response.audio_transcript.delta":
          fullTranscript += event.delta;
          activeClientWs?.send(JSON.stringify({
            type: "transcript_delta",
            text: event.delta,
          }));
          break;

        case "response.done": {
          // Only signal done to client if this response produced audio/text
          // (not when it's a function-call-only response)
          const hasOutput = event.response?.output?.some(
            (o: any) => o.type === "message"
          );
          if (hasOutput || fullTranscript) {
            activeClientWs?.send(JSON.stringify({
              type: "response_done",
              fullText: fullTranscript,
            }));
            fullTranscript = "";
          }
          break;
        }

        case "response.function_call_arguments.done": {
          const callId = event.call_id;
          const fnName = event.name;
          console.log(`[RealtimeChat] Function call: ${fnName}`, event.arguments);

          if (fnName === "web_search") {
            let query = "";
            try {
              const args = JSON.parse(event.arguments);
              query = args.query || "";
            } catch {
              query = "";
            }

            const searchResult = await executeWebSearch(query);
            console.log(`[RealtimeChat] Web search completed for: "${query}"`);

            // Send function output back to the conversation
            ws.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output: searchResult,
              },
            }));

            // Trigger response generation with the search results
            ws.send(JSON.stringify({ type: "response.create" }));
          }
          break;
        }

        case "error":
          console.error("[RealtimeChat] Azure error:", event.error);
          activeClientWs?.send(JSON.stringify({
            type: "error",
            message: event.error?.message || "Azure Realtime API error",
          }));
          break;
      }
    } catch (err) {
      console.error("[RealtimeChat] Error parsing Azure message:", err);
    }
  });

  ws.on("error", (err) => {
    console.error("[RealtimeChat] Azure WS error:", err.message);
    azureReady = false;
    activeClientWs?.send(JSON.stringify({
      type: "error",
      message: `Azure connection error: ${err.message}`,
    }));
  });

  ws.on("close", () => {
    console.log("[RealtimeChat] Azure WS closed");
    azureWs = null;
    azureReady = false;
  });
}

// ============================================================================
// Client WebSocket Handler
// ============================================================================

export function setupRealtimeChatProxy(server: http.Server): void {
  if (!AI_MODEL_REALTIME) {
    console.log("[RealtimeChat] AI_MODEL_REALTIME not set, skipping WebSocket setup");
    return;
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/realtime-chat")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (clientWs) => {
    console.log("[RealtimeChat] Client connected");
    activeClientWs = clientWs;

    // Connect to Azure (reuses existing session if alive)
    connectAzure(() => {
      clientWs.send(JSON.stringify({ type: "session_ready" }));
    });

    clientWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "user_text" && msg.text && azureWs && azureReady) {
          fullTranscript = "";

          // Send text as a conversation item
          azureWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: msg.text }],
            },
          }));

          // Trigger response generation
          azureWs.send(JSON.stringify({ type: "response.create" }));
        }
      } catch (err) {
        console.error("[RealtimeChat] Error parsing client message:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("[RealtimeChat] Client disconnected");
      if (activeClientWs === clientWs) {
        activeClientWs = null;
      }
      // Keep Azure session alive for next client connection
    });

    clientWs.on("error", (err) => {
      console.error("[RealtimeChat] Client WS error:", err.message);
      if (activeClientWs === clientWs) {
        activeClientWs = null;
      }
    });
  });

  console.log("[RealtimeChat] WebSocket proxy ready on /api/realtime-chat");
}
