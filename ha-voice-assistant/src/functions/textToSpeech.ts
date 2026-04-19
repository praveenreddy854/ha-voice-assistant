import {
  SpeechConfig,
  AudioConfig,
  SpeechSynthesizer,
  SpeechSynthesisOutputFormat,
  ResultReason,
} from "microsoft-cognitiveservices-speech-sdk";
import { getSpeechCredentials } from "../utils/config";

interface TextToSpeechOptions {
  text: string;
  fileName?: string;
  voice?: string;
}

interface TextToSpeechResult {
  success: boolean;
  message: string;
  audioBuffer?: ArrayBuffer;
  filePath?: string;
}

// Default Dragon HD voice (MAI-Voice-1)
const DEFAULT_VOICE = "en-US-Ava:DragonHDLatestNeural";

export const synthesizeTextToSpeech = async (
  options: TextToSpeechOptions
): Promise<TextToSpeechResult> => {
  const {
    text,
    fileName = `speech.mp3`,
    voice = DEFAULT_VOICE,
  } = options;

  try {
    const { speechKey, speechRegion } = await getSpeechCredentials();

    if (!speechKey || !speechRegion) {
      return {
        success: false,
        message:
          "Speech key or service region not set. Please check your .env file.",
      };
    }

    const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);

    speechConfig.speechSynthesisOutputFormat =
      SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3;

    speechConfig.speechSynthesisVoiceName = voice;

    // Dragon HD voices don't support <prosody> — use simple SSML with <voice> only
    const ssmlText = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}">${text}</voice></speak>`;

    const audioConfig = AudioConfig.fromAudioFileOutput(fileName);
    const synthesizer = new SpeechSynthesizer(speechConfig, audioConfig);

    return new Promise((resolve) => {
      synthesizer.speakSsmlAsync(
        ssmlText,
        (result) => {
          if (result.reason === ResultReason.SynthesizingAudioCompleted) {
            console.log(
              `Speech synthesis completed. Audio saved to ${fileName}`
            );
            resolve({
              success: true,
              message: `Audio successfully synthesized and saved to ${fileName}`,
              audioBuffer: result.audioData,
              filePath: fileName,
            });
          } else {
            console.error(`Speech synthesis failed: ${result.errorDetails}`);
            resolve({
              success: false,
              message: `Speech synthesis failed: ${result.errorDetails}`,
            });
          }
          synthesizer.close();
        },
        (error) => {
          console.error("Error during speech synthesis:", error);
          resolve({
            success: false,
            message: `Error during speech synthesis: ${error}`,
          });
          synthesizer.close();
        }
      );
    });
  } catch (error) {
    console.error("Error setting up text-to-speech:", error);
    return {
      success: false,
      message: `Error setting up text-to-speech: ${error}`,
    };
  }
};

// Synthesize to in-memory buffer (no file output)
export const synthesizeTextToBuffer = async (
  options: Omit<TextToSpeechOptions, "fileName">
): Promise<TextToSpeechResult> => {
  const {
    text,
    voice = DEFAULT_VOICE,
  } = options;

  try {
    const { speechKey, speechRegion } = await getSpeechCredentials();

    if (!speechKey || !speechRegion) {
      return {
        success: false,
        message:
          "Speech key or service region not set. Please check your .env file.",
      };
    }

    const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);

    speechConfig.speechSynthesisOutputFormat =
      SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3;

    speechConfig.speechSynthesisVoiceName = voice;

    // Dragon HD voices don't support <prosody> — use simple SSML with <voice> only
    const ssmlText = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}">${text}</voice></speak>`;

    const synthesizer = new SpeechSynthesizer(speechConfig);

    return new Promise((resolve) => {
      synthesizer.speakSsmlAsync(
        ssmlText,
        (result) => {
          if (result.reason === ResultReason.SynthesizingAudioCompleted) {
            console.log("Speech synthesis completed. Audio buffer ready.");
            resolve({
              success: true,
              message: "Audio successfully synthesized to buffer",
              audioBuffer: result.audioData,
            });
          } else {
            console.error(`Speech synthesis failed: ${result.errorDetails}`);
            resolve({
              success: false,
              message: `Speech synthesis failed: ${result.errorDetails}`,
            });
          }
          synthesizer.close();
        },
        (error) => {
          console.error("Error during speech synthesis:", error);
          resolve({
            success: false,
            message: `Error during speech synthesis: ${error}`,
          });
          synthesizer.close();
        }
      );
    });
  } catch (error) {
    console.error("Error setting up text-to-speech:", error);
    return {
      success: false,
      message: `Error setting up text-to-speech: ${error}`,
    };
  }
};

// Play audio from buffer using Web Audio API
export const playAudioFromBuffer = (audioBuffer: ArrayBuffer): void => {
  const audioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)();

  audioContext
    .decodeAudioData(audioBuffer)
    .then((decodedData) => {
      const source = audioContext.createBufferSource();
      source.buffer = decodedData;
      source.connect(audioContext.destination);
      source.start();
    })
    .catch((error) => {
      console.error("Error playing audio:", error);
    });
};

// Dragon HD voices available for MAI-Voice-1
export const availableVoices = {
  "en-US": [
    "en-US-Ava:DragonHDLatestNeural",
    "en-US-Andrew:DragonHDLatestNeural",
    "en-US-Aria:DragonHDLatestNeural",
    "en-US-Brian:DragonHDLatestNeural",
    "en-US-Davis:DragonHDLatestNeural",
    "en-US-Emma:DragonHDLatestNeural",
    "en-US-Jenny:DragonHDLatestNeural",
    "en-US-Nova:DragonHDLatestNeural",
    "en-US-Steffan:DragonHDLatestNeural",
  ],
};
