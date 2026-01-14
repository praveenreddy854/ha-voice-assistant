import React, { useRef, useState, useCallback, useEffect } from "react";
import "./App.css";
import {
  startAzureSpeechRecognition,
  stopRecognition,
} from "./functions/speechToText";
import Chat from "./Chat";
import { Message } from "./types/chat";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import { synthesizeTextToBuffer } from "./functions/textToSpeech";
import { USE_AZURE_SPEECH } from "./utils/config";
import { processRecognizedText } from "./functions/speech";
import { playChime } from "./functions/chime";
import { LaundryMonitor, VacuumMonitor, ReminderManager } from "./skills";
import SkillToggles from "./components/SkillToggles";
import SkillWrapper from "./components/SkillWrapper";
import TeachingModeUI from "./components/TeachingModeUI";
import HandGestureDetector from "./skills/gestures/HandGestureDetector";
import {
  SkillToggleState,
  loadSkillToggleState,
  saveSkillToggleState,
  isSkillEnabled,
} from "./utils/skillToggle";
import {
  hasActiveTeachingSession,
  isAwaitingTeachingTask,
} from "./functions/teaching";

declare global {
  interface Window {
    addReminderToManager?: (reminder: any) => void;
  }
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isWakeWordMode, setIsWakeWordMode] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [allReminders, setAllReminders] = useState<any[]>([]);
  const [skillState, setSkillState] = useState<SkillToggleState>(
    loadSkillToggleState()
  );
  const [isGestureCameraActive, setIsGestureCameraActive] = useState(false);
  const [showTeachingUI, setShowTeachingUI] = useState(false);
  const isListeningForWakeWord = useRef(false);

  const { finalTranscript, resetTranscript } = useSpeechRecognition();

  useEffect(() => {
    saveSkillToggleState(skillState);
  }, [skillState]);

  const handleToggleGlobal = useCallback((enabled: boolean) => {
    setSkillState((prev) => ({ ...prev, globalEnabled: enabled }));
  }, []);

  const handleToggleSkill = useCallback(
    (
      skill: keyof Omit<SkillToggleState, "globalEnabled">,
      enabled: boolean
    ) => {
      setSkillState((prev) => ({ ...prev, [skill]: enabled }));
    },
    []
  );

  const handleRecognizedText = useCallback(async (message: Message) => {
    setMessages((prevMessages) => [...prevMessages, message]);

    // Handle voice-created reminders
    if (message.reminderData) {
      // Convert service reminder format to local format
      const reminder = {
        ...message.reminderData,
        dueDate: new Date(message.reminderData.dueDate),
        createdAt: new Date(message.reminderData.createdAt),
        updatedAt: new Date(message.reminderData.updatedAt),
      };

      // Add directly to ReminderManager
      if (window.addReminderToManager) {
        window.addReminderToManager(reminder);
      }
    }

    if (message.sender === "assistant" && message.messageToAnnounce) {
      const { audioBuffer } = await synthesizeTextToBuffer({
        text: message.messageToAnnounce,
      });

      if (!audioBuffer) {
        console.error("Failed to synthesize text to audio buffer");
        return;
      }
    }
  }, []);

  const handleAnnouncement = useCallback(
    async (message: string) => {
      const assistantMessage: Message = {
        sender: "assistant",
        text: message,
        messageToAnnounce: message,
      };
      await handleRecognizedText(assistantMessage);
    },
    [handleRecognizedText]
  );

  const handleRemindersChange = useCallback((reminders: any[]) => {
    setAllReminders(reminders);
  }, []);

  // Handle successful teaching recording save
  const handleTeachingSaveComplete = useCallback((taskName: string, stepCount: number) => {
    const message: Message = {
      sender: "assistant",
      text: `✅ Fine-tuning data saved: "${taskName}" with ${stepCount} training examples added to JSONL.`,
    };
    setMessages((prev) => [...prev, message]);
  }, []);

  const processRecognizedTextCallback = useCallback(
    async (text: string) => {
      await processRecognizedText(
        text,
        handleRecognizedText,
        isListeningForWakeWord,
        allReminders
      );
    },
    [handleRecognizedText, allReminders]
  );

  const startWakeWordListening = useCallback(() => {
    console.log("Starting wake word listening...");
    resetTranscript(); // Clear any existing transcript
    setIsGestureCameraActive(false);
    SpeechRecognition.startListening({
      continuous: true,
      language: "en-US",
    });
    isListeningForWakeWord.current = true;
    setIsWakeWordMode(true);
    console.log(
      "Wake word listening started, isListeningForWakeWord:",
      isListeningForWakeWord.current
    );
  }, [resetTranscript]);

  React.useEffect(() => {
    // Check if we're in teaching mode (active session or awaiting task)
    const isInTeachingMode = hasActiveTeachingSession() || isAwaitingTeachingTask();
    
    // Use 5 minutes (300 seconds) for teaching mode, 30 seconds otherwise
    const timeoutDuration = isInTeachingMode ? 300000 : 30000; // 5 min or 30 sec
    const countdownStart = isInTeachingMode ? 300 : 30;
    
    // Auto-stop after timeout when listening for commands (not wake words)
    if (isListening && !isListeningForWakeWord.current) {
      setCountdown(countdownStart);
      setIsGestureCameraActive(true);

      // Update countdown every second
      const countdownInterval = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) {
            return null;
          }
          return prev - 1;
        });
      }, 1000);

      // Auto-stop timer
      const timer = setTimeout(() => {
        const modeLabel = isInTeachingMode ? "teaching mode (5 minutes)" : "30 seconds";
        console.log(`Auto stopping after ${modeLabel} of continuous listening`);
        setCountdown(null);
        handleRecognizedText({
          sender: "assistant",
          text: `Auto stopping after ${modeLabel} of continuous listening`,
        });
        if (USE_AZURE_SPEECH) {
          stopRecognition(
            {
              setRecognizedText: handleRecognizedText,
              setIsListening,
              isListeningForWakeWord,
              processRecognizedText: processRecognizedTextCallback,
              onSessionStopped: () => setIsGestureCameraActive(false),
            },
            () => {
              // Callback executed after Azure SDK is properly stopped
              console.log("Azure SDK stopped, starting wake word listening...");
              startWakeWordListening();
            }
          );
        } else {
          SpeechRecognition.stopListening().then(() => {
            console.log(
              "SpeechRecognition stopped, starting wake word listening..."
            );
            setIsListening(false);
            isListeningForWakeWord.current = true;
            setIsGestureCameraActive(false);
            handleRecognizedText({
              sender: "assistant",
              text: "Auto stopped listening for commands",
            });
            console.log("Azure SDK stopped, starting wake word listening...");
            startWakeWordListening();
          });
        }
      }, timeoutDuration); // 5 min for teaching mode, 30 sec otherwise

      return () => {
        clearTimeout(timer);
        clearInterval(countdownInterval);
        setCountdown(null);
      };
    } else {
      setCountdown(null);
    }
  }, [
    isListening,
    resetTranscript,
    startWakeWordListening,
    processRecognizedTextCallback,
    handleRecognizedText,
  ]);

  React.useEffect(() => {
    if (finalTranscript) {
      console.log(
        "Transcript received:",
        finalTranscript,
        "isListeningForWakeWord:",
        isListeningForWakeWord.current
      );
      if (
        finalTranscript.toLocaleLowerCase().includes("assistant") ||
        finalTranscript.toLocaleLowerCase().includes("hey assistant") ||
        finalTranscript.toLocaleLowerCase().includes("hey, assistant") ||
        finalTranscript.toLocaleLowerCase().includes("ok assistant") ||
        finalTranscript.toLocaleLowerCase().includes("ok, assistant")
      ) {
        // If the wake word is detected, reset the transcript and start listening for commands
        console.log("Wake word detected:", finalTranscript);
        playChime(); // Play chime sound
        handleRecognizedText({ sender: "user", text: finalTranscript });
        isListeningForWakeWord.current = false;
        setIsWakeWordMode(false);
        setIsListening(true);
        setIsGestureCameraActive(true);

        // Immediately start Azure speech recognition for command listening
        if (USE_AZURE_SPEECH) {
          SpeechRecognition.abortListening().then(() => {
            console.log(
              "SpeechRecognition aborted, starting Azure speech recognition..."
            );
            // Check if we're in teaching mode for extended silence timeout
            const isInTeachingMode = hasActiveTeachingSession() || isAwaitingTeachingTask();
            startAzureSpeechRecognition({
              setIsListening,
              setRecognizedText: handleRecognizedText,
              isListeningForWakeWord,
              processRecognizedText: processRecognizedTextCallback,
              onSessionStarted: () => setIsGestureCameraActive(true),
              onSessionStopped: () => setIsGestureCameraActive(false),
              extendedSilenceTimeout: isInTeachingMode,
            });
          });
        }
      } else if (isListening && !USE_AZURE_SPEECH) {
        // Process the recognized text directly for non-Azure speech
        processRecognizedTextCallback(finalTranscript);
      }

      resetTranscript();
    }
  }, [
    finalTranscript,
    isListening,
    resetTranscript,
    handleRecognizedText,
    processRecognizedTextCallback,
  ]);

  const handleOnStartRecognition = () => {
    startWakeWordListening();
  };

  return (
    <div className="App">
      <button
        onClick={handleOnStartRecognition}
        disabled={isListening || isListeningForWakeWord.current}
        style={{ marginBottom: 16 }}
      >
        {isWakeWordMode
          ? "Listening for wake word..."
          : isListening
          ? `Listening for commands... (${countdown}s)`
          : "Start Voice Assistant"}
      </button>
      <button
        onClick={() => {
          SpeechRecognition.abortListening();
          stopRecognition({
            setIsListening,
            isListeningForWakeWord,
            setRecognizedText: handleRecognizedText,
            processRecognizedText: processRecognizedTextCallback,
            onSessionStopped: () => setIsGestureCameraActive(false),
          });
        }}
        disabled={!isListening && !isListeningForWakeWord.current}
        style={{ marginBottom: 16, marginLeft: 16 }}
      >
        {isWakeWordMode
          ? "Stop Wake Word Detection"
          : isListening
          ? "Stop Command Listening"
          : "Stop Voice Assistant"}
      </button>
      {countdown !== null && (
        <div
          style={{
            marginBottom: 20,
            padding: "12px 24px",
            background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
            border: "2px solid rgba(245, 158, 11, 0.3)",
            borderRadius: "16px",
            fontSize: 16,
            fontWeight: 600,
            color: "#92400e",
            boxShadow: "0 4px 12px rgba(245, 158, 11, 0.2)",
            animation: "pulse 1s ease-in-out infinite",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ fontSize: "18px" }}>⏱️</span>
          Auto-stop in: {countdown}s
        </div>
      )}
      <Chat messages={messages} />

      <div
        style={{
          marginTop: "30px",
          borderTop: "2px solid #e0e0e0",
          paddingTop: "20px",
          width: "100%",
          maxWidth: "1200px",
        }}
      >
        <h2
          style={{
            marginBottom: "30px",
            color: "#1e293b",
            fontSize: "28px",
            fontWeight: "700",
            textAlign: "center",
            background: "linear-gradient(135deg, #334155 0%, #64748b 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          🏠 Smart Home Dashboard
        </h2>

        {/* Teaching Mode Button */}
        <div style={{ 
          display: "flex", 
          justifyContent: "center", 
          marginBottom: "20px" 
        }}>
          <button
            onClick={() => setShowTeachingUI(true)}
            style={{
              padding: "12px 24px",
              backgroundColor: "#8b5cf6",
              border: "none",
              borderRadius: "12px",
              color: "white",
              fontSize: "16px",
              fontWeight: "600",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              boxShadow: "0 4px 12px rgba(139, 92, 246, 0.3)",
              transition: "all 0.2s ease",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = "#7c3aed";
              e.currentTarget.style.transform = "translateY(-2px)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = "#8b5cf6";
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            📚 Open Teaching Mode
          </button>
        </div>

        <SkillToggles
          skillState={skillState}
          onToggleGlobal={handleToggleGlobal}
          onToggleSkill={handleToggleSkill}
        />

        <div
          className="dashboard-grid"
          style={{
            animation: "fadeIn 0.8s ease-out",
            justifyItems: "stretch",
          }}
        >
          <SkillWrapper
            skillName="Laundry Monitor"
            enabled={skillState.laundryMonitor}
            globalEnabled={skillState.globalEnabled}
            onToggle={(enabled) => handleToggleSkill("laundryMonitor", enabled)}
            description="Monitors laundry machine status"
          >
            <LaundryMonitor
              onAnnouncement={
                isSkillEnabled("laundryMonitor", skillState)
                  ? handleAnnouncement
                  : undefined
              }
              enabled={isSkillEnabled("laundryMonitor", skillState)}
            />
          </SkillWrapper>

          <SkillWrapper
            skillName="Vacuum Monitor"
            enabled={skillState.vacuumMonitor}
            globalEnabled={skillState.globalEnabled}
            onToggle={(enabled) => handleToggleSkill("vacuumMonitor", enabled)}
            description="Monitors vacuum cleaner status"
          >
            <VacuumMonitor
              onAnnouncement={
                isSkillEnabled("vacuumMonitor", skillState)
                  ? handleAnnouncement
                  : undefined
              }
              enabled={isSkillEnabled("vacuumMonitor", skillState)}
            />
          </SkillWrapper>

          <SkillWrapper
            skillName="Voice Reminders"
            enabled={skillState.reminderManager}
            globalEnabled={skillState.globalEnabled}
            onToggle={(enabled) =>
              handleToggleSkill("reminderManager", enabled)
            }
            description="Voice-controlled reminder system"
          >
            <ReminderManager
              onAnnouncement={
                isSkillEnabled("reminderManager", skillState)
                  ? handleAnnouncement
                  : undefined
              }
              onRemindersChange={handleRemindersChange}
              enabled={isSkillEnabled("reminderManager", skillState)}
            />
          </SkillWrapper>
        </div>
      </div>

      {/* Gesture Detection Section */}
      <div
        style={{
          marginTop: "40px",
          borderTop: "2px solid #e0e0e0",
          paddingTop: "30px",
          width: "100%",
          maxWidth: "1200px",
        }}
      >
        <h2
          style={{
            marginBottom: "30px",
            color: "#1e293b",
            fontSize: "28px",
            fontWeight: "700",
            textAlign: "center",
            background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          🤲 Gesture Control
        </h2>

        <HandGestureDetector active={isGestureCameraActive} />
      </div>

      {/* Teaching Mode UI Modal */}
      {showTeachingUI && (
        <TeachingModeUI
          onClose={() => setShowTeachingUI(false)}
          onSaveComplete={handleTeachingSaveComplete}
        />
      )}
    </div>
  );
}

export default App;
