import { getIntent, Intent, processReminder } from "./intent";
import { postHaCommand } from "./ha";
import { Message } from "../types/chat";
import { runTvAgenticFlow, getLastSessionLog } from "./tvAgent";
import {
  runTeachingMode,
  continueTeachingWithTask,
  isAwaitingTeachingTask,
  completeTeachingSession,
  cancelTeachingSession,
  hasActiveTeachingSession,
  getStepCount,
  recordStep,
  setTeachingTimeoutCallback,
} from "./teaching";
import { startRealtimeChat } from "./realtimeChat";
import { messageHistoryManager } from "../utils/sessionManager";

export const processRecognizedText = async (
  text: string,
  handleRecognizedText: (message: Message) => void,
  isListeningForWakeWord: React.RefObject<boolean>,
  currentReminders?: any[]
) => {
  const lowerText = text.toLowerCase().trim();
  
  // Handle stop command
  if (lowerText === "stop" || lowerText === "stop it") {
    isListeningForWakeWord.current = true;
    // Cancel any active teaching session
    if (hasActiveTeachingSession()) {
      await cancelTeachingSession();
    }
    handleRecognizedText({ sender: "user", text: "Stop" });
    return;
  }

  handleRecognizedText({ sender: "user", text });

  // Check if we're in an active teaching session (manual mode)
  // User stays engaged - no wake word needed, just describe steps
  if (hasActiveTeachingSession()) {
    // Check for completion phrases
    const completionPhrases = [
      "teaching complete", "done teaching", "finish teaching", "complete teaching",
      "i'm done", "im done", "i am done", "that's it", "thats it",
      "all done", "finished", "done", "finish", "end teaching", "save it", "save this"
    ];
    const isCompletionRequest = completionPhrases.some(phrase => lowerText.includes(phrase));
    
    if (isCompletionRequest) {
      const stepCount = getStepCount();
      const result = await completeTeachingSession();
      if (result.success && result.data) {
        handleRecognizedText({
          sender: "assistant",
          text: `Teaching complete! Recorded ${result.data.totalSteps} steps for "${result.data.taskName}".`,
          messageToAnnounce: `Teaching complete. ${result.data.totalSteps} steps recorded.`,
        });
      } else {
        handleRecognizedText({
          sender: "assistant",
          text: result.errorMessage || `Failed to complete teaching session. ${stepCount} steps recorded.`,
          messageToAnnounce: result.errorMessage || "Failed to complete.",
        });
      }
      return;
    }

    // Check for cancel phrases
    const cancelPhrases = [
      "cancel teaching", "stop teaching", "abort teaching",
      "cancel this", "cancel it", "never mind", "nevermind", "discard"
    ];
    const isCancelRequest = cancelPhrases.some(phrase => lowerText.includes(phrase));
    
    if (isCancelRequest) {
      const stepCount = getStepCount();
      await cancelTeachingSession();
      handleRecognizedText({
        sender: "assistant",
        text: `Teaching cancelled. ${stepCount} steps discarded.`,
        messageToAnnounce: "Teaching cancelled.",
      });
      return;
    }

    // Any other speech during teaching mode = record as a step
    // User is describing what they did (e.g., "I pressed right twice")
    const stepResult = await recordStep(text);
    if (stepResult.success && stepResult.data) {
      // Print only - no announce during step recording
      handleRecognizedText({
        sender: "assistant",
        text: `Step ${stepResult.data.stepNumber}: ${stepResult.data.action}`,
        // No messageToAnnounce - stay quiet during recording
      });
    } else {
      handleRecognizedText({
        sender: "assistant",
        text: stepResult.errorMessage || "Failed to record step.",
        // No messageToAnnounce
      });
    }
    return;
  }

  // Check if we're awaiting a task name for teaching mode
  if (isAwaitingTeachingTask()) {
    console.log(`[Speech] Starting teaching session with task: "${text}"`);
    
    const teachingResult = await continueTeachingWithTask(text);
    if (teachingResult.success && teachingResult.data) {
      // Print only - no announce after task is given
      handleRecognizedText({
        sender: "assistant",
        text: teachingResult.data.message || `Recording steps for "${text}". Tell me each step.`,
        // No messageToAnnounce - stay quiet, user is engaged
      });
    } else {
      handleRecognizedText({
        sender: "assistant",
        text: teachingResult.errorMessage || "Failed to start teaching session.",
        messageToAnnounce: teachingResult.errorMessage || "Failed to start.",
      });
    }
    return;
  }

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
      const agenticResult = await runTvAgenticFlow(text);
      const sessionLog = getLastSessionLog();
      if (agenticResult.success && agenticResult.data) {
        const { message, steps, finalCommand } = agenticResult.data;
        handleRecognizedText({
          sender: "assistant",
          text:
            message ||
            "Completed the requested TV task using the on-screen agent.",
          messageToAnnounce: "Done",
          agenticSteps: steps,
          finalCommand,
          sessionLog,
        });
      } else {
        handleRecognizedText({
          sender: "assistant",
          text:
            agenticResult.errorMessage ||
            "I couldn't complete that TV task right now.",
          messageToAnnounce: "Something went wrong",
          sessionLog,
        });
      }
    } else if (intent === Intent.TeachingMode) {
      // Handle teaching mode - initiate the two-step flow
      // Step 1: Ask for the task name
      const teachingResult = await runTeachingMode(text);
      if (teachingResult.success && teachingResult.data) {
        const { message, status } = teachingResult.data;
        
        // Should be awaiting_task status - ask user for task name
        if (status === "awaiting_task") {
          handleRecognizedText({
            sender: "assistant",
            text: message || "What is the task for TV agent?",
            messageToAnnounce: message || "What is the task for TV agent?",
          });
        } else {
          // Unexpected status, show the message
          handleRecognizedText({
            sender: "assistant",
            text: message || "Teaching mode activated.",
            messageToAnnounce: message || "Teaching mode activated.",
          });
        }
      } else {
        const errorMessage =
          teachingResult.errorMessage ||
          "I couldn't start teaching mode.";
        handleRecognizedText({
          sender: "assistant",
          text: errorMessage,
          messageToAnnounce: errorMessage,
        });
      }
    } else if (intent === Intent.Chat) {
      let fullTranscript = "";

      await startRealtimeChat(
        text,
        (delta) => {
          fullTranscript += delta;
        },
        (finalText) => {
          const responseText = finalText || fullTranscript || "Chat response received.";
          handleRecognizedText({
            sender: "assistant",
            text: responseText,
            // No messageToAnnounce — Realtime API audio is already playing
          });
          messageHistoryManager.addMessage("assistant", responseText);
        },
        (error) => {
          handleRecognizedText({
            sender: "assistant",
            text: `Chat error: ${error}`,
            messageToAnnounce: "Sorry, I couldn't process that.",
          });
        }
      );
    }
  }
};
