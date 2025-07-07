import { getIntent, Intent } from "./intent";
import { postHaCommand } from "./ha";
import { Message } from "../types/chat";

export const processRecognizedText = async (
  text: string,
  handleRecognizedText: (message: Message) => void,
  isListeningForWakeWord: React.RefObject<boolean>
) => {
  if (text.toLowerCase() === "stop" || text.toLowerCase() === "stop it") {
    isListeningForWakeWord.current = true;
    handleRecognizedText({ sender: "user", text: "Stop" });
    return;
  }

  handleRecognizedText({ sender: "user", text });
  // Check intent of the recognized text
  const response = await getIntent(text);

  if (response.success && response.data) {
    const intent = response.data;

    if (intent === Intent.HACommand) {
      // Handle Home Assistant command
      const result = await postHaCommand(text);
      handleRecognizedText({
        sender: "assistant",
        text: `Command executed: Success: ${result.success}, Message: ${result.message}`,
        messageToAnnounce: result.message,
      });
    } else if (intent === Intent.Chat) {
      // Handle chat intent (if applicable)
      console.log("Chat intent recognized:", text);
    }
  }
};
