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
  rate?: string;
  pitch?: string;
}

interface TextToSpeechResult {
  success: boolean;
  message: string;
  audioBuffer?: ArrayBuffer;
  filePath?: string;
}

export const synthesizeTextToSpeech = async (
  options: TextToSpeechOptions
): Promise<TextToSpeechResult> => {
  const {
    text,
    fileName = `speech.mp3`,
    voice = "en-US-AriaNeural",
    rate = "0%",
    pitch = "0%",
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

    // Set the output format to MP3
    speechConfig.speechSynthesisOutputFormat =
      SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3;

    // Set the voice
    speechConfig.speechSynthesisVoiceName = voice;

    // Create SSML text with rate and pitch control
    const ssmlText = `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
        <voice name="${voice}">
          <prosody rate="${rate}" pitch="${pitch}">
            ${text}
          </prosody>
        </voice>
      </speak>
    `;

    // Create audio config for file output
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

// Alternative function to get audio buffer without saving to file
export const synthesizeTextToBuffer = async (
  options: Omit<TextToSpeechOptions, "fileName">
): Promise<TextToSpeechResult> => {
  const {
    text,
    voice = "en-US-AriaNeural",
    rate = "0%",
    pitch = "0%",
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

    // Set the output format to MP3
    speechConfig.speechSynthesisOutputFormat =
      SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3;

    // Set the voice
    speechConfig.speechSynthesisVoiceName = voice;

    // Create SSML text with rate and pitch control
    const ssmlText = `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
        <voice name="${voice}">
          <prosody rate="${rate}" pitch="${pitch}">
            ${text}
          </prosody>
        </voice>
      </speak>
    `;

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

// Helper function to play audio from buffer (for web environments)
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

// Available voices for reference
export const availableVoices = {
  "en-US": [
    "en-US-AriaNeural",
    "en-US-JennyNeural",
    "en-US-GuyNeural",
    "en-US-AmberNeural",
    "en-US-AnaNeural",
    "en-US-AndrewNeural",
    "en-US-AshleyNeural",
    "en-US-BrandonNeural",
    "en-US-ChristopherNeural",
    "en-US-CoraNeural",
    "en-US-ElizabethNeural",
    "en-US-EricNeural",
    "en-US-JacobNeural",
    "en-US-MichelleNeural",
    "en-US-MonicaNeural",
    "en-US-RogerNeural",
    "en-US-SteffanNeural",
  ],
};
