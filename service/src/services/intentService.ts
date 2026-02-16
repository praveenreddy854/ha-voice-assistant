import path from "path";
import { openAIService } from "../aiService";
import {
  IntentClassificationResponse,
  IntentErrorResponse,
} from "../intent";
import { ChatMessage } from "./homeAssistantService";
import { PromptTemplateService } from "./promptTemplateService";
import { SpanKind, addStoryEvent, withSpan } from "../tracing";

export class IntentService {
  private readonly promptService: PromptTemplateService;

  constructor() {
    this.promptService = new PromptTemplateService(
      path.join(__dirname, "..", "prompts")
    );
  }

  public async classify(
    userPrompt: string,
    messageHistory?: ChatMessage[]
  ): Promise<IntentClassificationResponse | IntentErrorResponse> {
    return withSpan(
      "intent.classify",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "intent.prompt.length": userPrompt.length,
          "intent.history.count": messageHistory?.length || 0,
        },
      },
      async (span) => {
        const prompt = this.promptService
          .load("INTENT.md")
          .replace("{{{UserPrompt}}}", userPrompt);

        addStoryEvent(span, "intent.prompt.built", {
          "intent.compiled_prompt.length": prompt.length,
        });

        const messages: ChatMessage[] = [
          ...(messageHistory || []),
          { role: "user", content: prompt },
        ];

        const result = await openAIService.createIntentClassification(messages);
        addStoryEvent(span, "intent.classification.completed", {
          "intent.result":
            "intent" in result ? result.intent : result.error || "unknown",
        });
        return result;
      }
    );
  }
}

export const intentService = new IntentService();
