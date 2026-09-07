import React, { useRef, useState, useCallback, useEffect } from "react";
import "./App.css";
import Chat from "./Chat";
import { Message } from "./types/chat";
import { useWakeWordListener } from "./hooks/useWakeWordListener";
import { useVoiceWakeLock } from "./hooks/useVoiceWakeLock";
import {
  playAudioFromBuffer,
  synthesizeTextToBuffer,
} from "./functions/textToSpeech";
import { noteAnnouncement } from "./utils/recentAnnouncements";
import {
  prepareRealtimeAudioOutput,
  pauseActiveAgentRun,
  setAsyncAssistantSpeechEndHandler,
  setAsyncJobEventHandler,
  setAgentRunPausedHandler,
  setCommandCancelledHandler,
  startRealtimeChat,
  startRealtimeVoiceTurn,
  stopRealtimeChat,
} from "./functions/realtimeChat";
import { playPing } from "./functions/chime";
import { LaundryMonitor, VacuumMonitor } from "./skills";
import SkillToggles from "./components/SkillToggles";
import SkillWrapper from "./components/SkillWrapper";
import TeachingModeUI from "./components/TeachingModeUI";
import Header, { ActiveView } from "./components/Header";
import ScheduledTasksPage from "./pages/ScheduledTasksPage";
import HandGestureDetector from "./skills/gestures/HandGestureDetector";
import { BASE_URL } from "./functions/httpUtils";
import {
  SkillToggleState,
  loadSkillToggleState,
  saveSkillToggleState,
  isSkillEnabled,
} from "./utils/skillToggle";

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isWakeWordMode, setIsWakeWordMode] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [skillState, setSkillState] = useState<SkillToggleState>(
    loadSkillToggleState()
  );
  const [isGestureCameraActive, setIsGestureCameraActive] = useState(false);
  const [showTeachingUI, setShowTeachingUI] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("main");
  const isListeningForWakeWord = useRef(false);
  const hasActiveAgentRun = useRef(false);

  const assistantEnabled = useRef(false);
  const assistantLifecycle = useRef(0);
  const voiceTurnVersion = useRef(0);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const {
    finalTranscript, resetTranscript, status: wakeWordStatus, error: microphoneError,
    startListening: startWakeListener, stopListening: stopWakeListener,
  } = useWakeWordListener();
  useVoiceWakeLock(voiceEnabled);

  const stopVoiceAssistant = useCallback(() => {
    assistantEnabled.current = false;
    assistantLifecycle.current++;
    voiceTurnVersion.current++;
    setVoiceEnabled(false);
    isListeningForWakeWord.current = false;
    void stopWakeListener();
    stopRealtimeChat({ closeAudioOutput: true });
    setIsListening(false);
    setCountdown(null);
    setIsWakeWordMode(false);
    setIsGestureCameraActive(false);
  }, [stopWakeListener]);

  useEffect(() => {
    if (microphoneError) stopVoiceAssistant();
  }, [microphoneError, stopVoiceAssistant]);

  useEffect(() => () => {
    assistantEnabled.current = false;
    assistantLifecycle.current++;
    stopRealtimeChat({ closeAudioOutput: true });
  }, []);

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

    if (message.sender === "assistant" && message.messageToAnnounce) {
      // Record what we're about to speak so mic-recognized echo can be ignored.
      noteAnnouncement(message.messageToAnnounce);
      const { audioBuffer } = await synthesizeTextToBuffer({
        text: message.messageToAnnounce,
      });

      if (!audioBuffer) {
        console.error("Failed to synthesize text to audio buffer");
        return;
      }
      playAudioFromBuffer(audioBuffer);
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

  useEffect(() => {
    const source = new EventSource(`${BASE_URL}/announcements/stream`);
    source.addEventListener("announcement", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          message?: string;
        };
        if (payload.message) {
          void handleAnnouncement(payload.message);
        }
      } catch (error) {
        console.error("Failed to parse announcement event:", error);
      }
    });
    source.onerror = () => {
      // EventSource reconnects automatically.
    };
    return () => source.close();
  }, [handleAnnouncement]);

  // Handle successful teaching recording save
  const handleTeachingSaveComplete = useCallback((taskName: string, stepCount: number) => {
    const message: Message = {
      sender: "assistant",
      text: `✅ Fine-tuning data saved: "${taskName}" with ${stepCount} training examples added to JSONL.`,
    };
    setMessages((prev) => [...prev, message]);
  }, []);

  const startWakeWordListening = useCallback(() => {
    if (!assistantEnabled.current) return;
    setIsGestureCameraActive(false);
    isListeningForWakeWord.current = true;
    setIsWakeWordMode(true);
    startWakeListener();
  }, [startWakeListener]);

  const handleTextCommand = useCallback(
    async (text: string, resumeWakeWord = true) => {
      const lifecycle = assistantLifecycle.current;
      const version = ++voiceTurnVersion.current;
      isListeningForWakeWord.current = false;
      setIsWakeWordMode(false);
      setIsListening(false);
      setCountdown(null);
      setIsGestureCameraActive(false);
      await stopWakeListener();
      if (lifecycle !== assistantLifecycle.current || version !== voiceTurnVersion.current) return;
      handleRecognizedText({ sender: "user", text });
      let fullTranscript = "";
      await startRealtimeChat(
        text,
        (delta) => {
          fullTranscript += delta;
        },
        (finalText) => {
          const responseText =
            finalText || fullTranscript || "Response received.";
          handleRecognizedText({
            sender: "assistant",
            text: responseText,
          });
          noteAnnouncement(responseText);
        },
        (error) => {
          handleRecognizedText({
            sender: "assistant",
            text: `Chat error: ${error}`,
          });
        }
      );
      if (resumeWakeWord && lifecycle === assistantLifecycle.current && version === voiceTurnVersion.current) {
        startWakeWordListening();
      }
    },
    [handleRecognizedText, startWakeWordListening, stopWakeListener]
  );

  const enterVoiceTurn = useCallback(() => {
    if (!assistantEnabled.current) return;
    const lifecycle = assistantLifecycle.current;
    const version = ++voiceTurnVersion.current;
    isListeningForWakeWord.current = false;
    setIsWakeWordMode(false);
    setIsListening(true);
    setIsGestureCameraActive(true);
    playPing();
    let fullTranscript = "";
    let asyncJobStarted = false;
    stopWakeListener().then(() => {
      if (!assistantEnabled.current || lifecycle !== assistantLifecycle.current || version !== voiceTurnVersion.current) return;
      return startRealtimeVoiceTurn(
        (delta) => {
          fullTranscript += delta;
        },
        (finalText) => {
          const responseText =
            finalText || fullTranscript || "Response received.";
          handleRecognizedText({
            sender: "assistant",
            text: responseText,
          });
          noteAnnouncement(responseText);
          fullTranscript = "";
        },
        (error) => {
          handleRecognizedText({
            sender: "assistant",
            text: `Realtime error: ${error}`,
          });
        },
        (userTranscript) => {
          handleRecognizedText({
            sender: "user",
            text: userTranscript,
          });
        },
        () => {
          asyncJobStarted = true;
          hasActiveAgentRun.current = true;
        },
        () => {
          hasActiveAgentRun.current = false;
        },
        {
          onListeningWindowChange: setCountdown,
        }
      );
    }).finally(() => {
      if (!assistantEnabled.current || lifecycle !== assistantLifecycle.current || version !== voiceTurnVersion.current) return;
      setIsListening(false);
      setCountdown(null);
      isListeningForWakeWord.current = true;
      setIsGestureCameraActive(false);
      if (!asyncJobStarted) {
        stopRealtimeChat();
      }
      playPing();
      startWakeWordListening();
    });
  }, [handleRecognizedText, startWakeWordListening, stopWakeListener]);

  useEffect(() => {
    setAsyncJobEventHandler((event) => {
      if (!assistantEnabled.current) return;
      if (event.kind !== "needs_input") {
        hasActiveAgentRun.current = false;
      }
      void stopWakeListener();
      isListeningForWakeWord.current = false;
      setIsWakeWordMode(false);
    });
    setAsyncAssistantSpeechEndHandler(({ followupExpected }) => {
      if (!assistantEnabled.current) return;
      if (followupExpected) {
        enterVoiceTurn();
      } else {
        playPing();
        startWakeWordListening();
      }
    });
    setCommandCancelledHandler(({ tvJobId }) => {
      hasActiveAgentRun.current = false;
      const note = tvJobId
        ? "Cancelled the active TV command. Listening for wake word."
        : "Cancelled. Listening for wake word.";
      setMessages((prev) => [...prev, { sender: "assistant", text: note }]);
    });
    setAgentRunPausedHandler(({ domain }) => {
      hasActiveAgentRun.current = false;
      setMessages((prev) => [
        ...prev,
        {
          sender: "assistant",
          text:
            domain === "tv"
              ? "Paused the active TV command. Listening for your follow-up."
              : domain === "scheduled_task"
                ? "Paused the scheduled task action. Listening for your follow-up."
                : domain === "home_assistant"
                  ? "Paused the Home Assistant action. Listening for your follow-up."
                  : "Paused. Listening for your follow-up.",
        },
      ]);
    });
    return () => {
      setAsyncJobEventHandler(undefined);
      setAsyncAssistantSpeechEndHandler(undefined);
      setCommandCancelledHandler(undefined);
      setAgentRunPausedHandler(undefined);
    };
  }, [enterVoiceTurn, startWakeWordListening, stopWakeListener]);

  React.useEffect(() => {
    if (finalTranscript) {
      console.log(
        "Transcript received:",
        finalTranscript,
        "isListeningForWakeWord:",
        isListeningForWakeWord.current
      );
      const lower = finalTranscript.toLocaleLowerCase();
      const wakeMatch = lower.match(
        /^\s*(?:hey[,\s]+|ok[,\s]+)?assistant\b[,.\s]*(.*)$/
      );
      if (wakeMatch && assistantEnabled.current && isListeningForWakeWord.current) {
        const lifecycle = assistantLifecycle.current;
        const trailing = wakeMatch[1]?.trim() ?? "";
        console.log("Wake word detected:", finalTranscript, "trailing:", trailing);
        handleRecognizedText({ sender: "user", text: finalTranscript });
        const pauseRequest = hasActiveAgentRun.current
          ? pauseActiveAgentRun().catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              handleRecognizedText({
                sender: "assistant",
                text: `Unable to pause the active command: ${message}`,
              });
            })
          : Promise.resolve();
        isListeningForWakeWord.current = false;
        setIsWakeWordMode(false);

        Promise.all([stopWakeListener(), pauseRequest]).then(() => {
          if (!assistantEnabled.current || lifecycle !== assistantLifecycle.current) return;
          if (trailing) {
            // User said the question in the same breath as the wake word —
            // route it via user_text so the realtime API responds immediately,
            // then open the realtime mic so the user can ask a follow-up
            // within the 30s listening window without re-saying the wake word.
            console.log("Routing trailing text as command:", trailing);
            handleTextCommand(trailing, false).finally(() => {
              if (!assistantEnabled.current || lifecycle !== assistantLifecycle.current) return;
              enterVoiceTurn();
            });
          } else {
            // Bare wake word — open the realtime mic for the next utterance.
            console.log(
              "SpeechRecognition aborted, starting realtime voice turn..."
            );
            enterVoiceTurn();
          }
        });
      }

      resetTranscript();
    }
  }, [
    finalTranscript,
    resetTranscript,
    handleRecognizedText,
    enterVoiceTurn,
    handleTextCommand,
    startWakeWordListening,
    stopWakeListener,
  ]);

  const handleOnStartRecognition = () => {
    assistantEnabled.current = true;
    assistantLifecycle.current++;
    setVoiceEnabled(true);
    prepareRealtimeAudioOutput();
    startWakeWordListening();
  };

  return (
    <div className="App">
      <Header activeView={activeView} onChangeView={setActiveView} />
      {activeView === "scheduledTasks" && <ScheduledTasksPage />}
      {activeView === "main" && (
      <>
      <button
        onClick={handleOnStartRecognition}
        disabled={voiceEnabled}
        style={{ marginBottom: 16 }}
      >
        {isWakeWordMode
          ? wakeWordStatus === "listening"
            ? "Listening for wake word..."
            : wakeWordStatus === "starting" ? "Starting microphone..." : "Reconnecting microphone..."
          : isListening
          ? `Listening for commands${countdown !== null ? `... (${countdown}s)` : "..."}`
          : voiceEnabled ? "Processing command..."
          : "Start Voice Assistant"}
      </button>
      <button
        onClick={stopVoiceAssistant}
        disabled={!voiceEnabled}
        style={{ marginBottom: 16, marginLeft: 16 }}
      >
        {isWakeWordMode
          ? "Stop Wake Word Detection"
          : isListening
          ? "Stop Command Listening"
          : "Stop Voice Assistant"}
      </button>
      {microphoneError && <p role="alert">{microphoneError}</p>}
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
      <Chat messages={messages} onSendMessage={handleTextCommand} />

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
      </>
      )}

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
