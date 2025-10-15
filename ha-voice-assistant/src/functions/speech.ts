import { getIntent, Intent, processReminder } from "./intent";
import { postHaCommand } from "./ha";
import { Message } from "../types/chat";
import { runAgenticFlow } from "./agentic";

export const processRecognizedText = async (
  text: string,
  handleRecognizedText: (message: Message) => void,
  isListeningForWakeWord: React.RefObject<boolean>,
  currentReminders?: any[]
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
    } else if (intent === Intent.Reminder) {
      // Handle all reminder intents (CREATE, LIST, QUERY) with unified API
      const reminderResult = await processReminder(text, currentReminders || []);
      if (reminderResult.success) {
        const message = reminderResult.message || "Reminder processed successfully";
        handleRecognizedText({
          sender: "assistant",
          text: message,
          messageToAnnounce: message,
          reminderData: reminderResult.data,
        });
      } else {
        handleRecognizedText({
          sender: "assistant",
          text: `Failed to process reminder: ${reminderResult.errorMessage}`,
          messageToAnnounce: `Sorry, I couldn't process that reminder request. ${reminderResult.errorMessage}`,
        });
      }
    } else if (intent === Intent.AgenticFlow) {
      const agenticResult = await runAgenticFlow(text);
      if (agenticResult.success && agenticResult.data) {
        const { message, steps, finalCommand } = agenticResult.data;
        handleRecognizedText({
          sender: "assistant",
          text:
            message ||
            "Completed the requested TV task using the on-screen agent.",
          messageToAnnounce:
            message ||
            "I completed the requested TV interaction.",
          agenticSteps: steps,
          finalCommand,
        });
      } else {
        const errorMessage =
          agenticResult.errorMessage ||
          "I couldn't complete that TV task right now.";
        handleRecognizedText({
          sender: "assistant",
          text: errorMessage,
          messageToAnnounce: errorMessage,
        });
      }
    } else if (intent === Intent.Chat) {
      // Handle chat intent (if applicable)
      console.log("Chat intent recognized:", text);
    }
  }
};
