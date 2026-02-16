import axios from "axios";
import { SPEECH_KEY, SPEECH_REGION } from "../config";
import { SpanKind, addStoryEvent, withSpan } from "../tracing";

export class SpeechService {
  public async getSpeechToken(): Promise<{ token: string; region: string }> {
    return withSpan(
      "speech.get_token",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "speech.region": SPEECH_REGION,
        },
      },
      async (span) => {
        if (!SPEECH_KEY) {
          throw new Error("Azure Speech Service key is not configured");
        }

        const tokenEndpoint = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
        addStoryEvent(span, "speech.token.request_started", {
          "speech.endpoint": tokenEndpoint,
        });

        const response = await axios.post<string>(tokenEndpoint, undefined, {
          headers: {
            "Ocp-Apim-Subscription-Key": SPEECH_KEY,
            "Content-Type": "application/json",
          },
        });

        addStoryEvent(span, "speech.token.request_completed", {
          "speech.token.length": response.data?.length || 0,
        });

        return {
          token: response.data,
          region: SPEECH_REGION,
        };
      }
    );
  }

  public getSpeechCredentials(): { speechKey: string; speechRegion: string } {
    if (!SPEECH_KEY || !SPEECH_REGION) {
      throw new Error("Azure Speech Service key or region is not configured");
    }

    return {
      speechKey: SPEECH_KEY,
      speechRegion: SPEECH_REGION,
    };
  }
}

export const speechService = new SpeechService();
