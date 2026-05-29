# Graph Report - .  (2026-05-22)

## Corpus Check
- Corpus is ~19,726 words - fits in a single context window. You may not need a graph.

## Summary
- 329 nodes · 449 edges · 28 communities (19 shown, 9 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 32 edges (avg confidence: 0.83)
- Token cost: 161,932 input · 14,079 output

## Community Hubs (Navigation)
- [[_COMMUNITY_NPM Dependencies & Build|NPM Dependencies & Build]]
- [[_COMMUNITY_UI Chrome & TTS Output|UI Chrome & TTS Output]]
- [[_COMMUNITY_Teaching Mode & Agent Logs|Teaching Mode & Agent Logs]]
- [[_COMMUNITY_Chat & Status Card UI|Chat & Status Card UI]]
- [[_COMMUNITY_Realtime Voice Turn|Realtime Voice Turn]]
- [[_COMMUNITY_TV Camera & Gesture Capture|TV Camera & Gesture Capture]]
- [[_COMMUNITY_Skill Toggles & Scheduled Tasks|Skill Toggles & Scheduled Tasks]]
- [[_COMMUNITY_Message History & Sessions|Message History & Sessions]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_App Bootstrap & Wake Word Flow|App Bootstrap & Wake Word Flow]]
- [[_COMMUNITY_PWA Manifest|PWA Manifest]]
- [[_COMMUNITY_TTS Echo Filter|TTS Echo Filter]]
- [[_COMMUNITY_Speech Credentials & Camera Decision|Speech Credentials & Camera Decision]]
- [[_COMMUNITY_Vacuum Monitor Skill|Vacuum Monitor Skill]]
- [[_COMMUNITY_React Logo Assets|React Logo Assets]]
- [[_COMMUNITY_Webpack Override|Webpack Override]]
- [[_COMMUNITY_PWA Manifest Doc|PWA Manifest Doc]]
- [[_COMMUNITY_Front-end README|Front-end README]]
- [[_COMMUNITY_Response Envelope Type|Response Envelope Type]]
- [[_COMMUNITY_Header Component|Header Component]]
- [[_COMMUNITY_Hand Gesture Detector|Hand Gesture Detector]]
- [[_COMMUNITY_React Logo 512px|React Logo 512px]]
- [[_COMMUNITY_React Logo SVG|React Logo SVG]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 16 edges
2. `MessageHistoryManager` - 12 edges
3. `TvCameraController` - 11 edges
4. `handleMessage()` - 8 edges
5. `httpPost()` - 8 edges
6. `App component (root)` - 8 edges
7. `Message` - 7 edges
8. `stopMicStreaming()` - 7 edges
9. `startRealtimeVoiceTurn()` - 7 edges
10. `scripts` - 6 edges

## Surprising Connections (you probably didn't know these)
- `MessageHistoryManager (5min memory)` --semantically_similar_to--> `Message`  [INFERRED] [semantically similar]
  ha-voice-assistant/src/utils/sessionManager.ts → src/types/chat.ts
- `Chat component` --shares_data_with--> `Message`  [EXTRACTED]
  ha-voice-assistant/src/Chat.tsx → src/types/chat.ts
- `Message` --references--> `Agentic flow & teaching types`  [EXTRACTED]
  src/types/chat.ts → ha-voice-assistant/src/types/agentic.ts
- `TeachingModeUI.handleCaptureScreenshot` --semantically_similar_to--> `recordStep()`  [INFERRED] [semantically similar]
  src/components/TeachingModeUI.tsx → src/functions/teaching.ts
- `HTML entry point` --references--> `React DOM entry (index.tsx)`  [INFERRED]
  ha-voice-assistant/public/index.html → ha-voice-assistant/src/index.tsx

## Hyperedges (group relationships)
- **Wake-word detection -> realtime voice turn -> TTS echo guard** — src_app, utils_recentannouncements, concept_wakeword_flow [INFERRED 0.85]
- **Client-side localStorage state** — utils_skilltoggle, utils_sessionmanager, src_app [INFERRED 0.75]
- **Skill toggle UI pattern** — components_skilltoggles_component, components_skillwrapper_component, components_toggleswitch_component [INFERRED 0.85]
- **Teaching mode recording flow** — components_teachingmodeui_component, functions_teaching_startteachingsession, functions_teaching_recordstep, functions_teaching_completeteachingsession [INFERRED 0.85]
- **Realtime voice turn lifecycle** — functions_realtimechat_startrealtimevoiceturn, functions_realtimechat_connectrealtime, functions_realtimechat_startmicstreaming, functions_realtimechat_handlemessage, functions_realtimechat_finishresponse, functions_realtimechat_startlisteningwindow [INFERRED 0.85]

## Communities (28 total, 9 thin omitted)

### Community 0 - "NPM Dependencies & Build"
Cohesion: 0.05
Nodes (43): browserslist, development, production, dependencies, axios, buffer, crypto-browserify, dotenv (+35 more)

### Community 1 - "UI Chrome & TTS Output"
Cohesion: 0.08
Nodes (23): activeLinkStyle, ActiveView, HeaderProps, linkStyle, SkillTogglesProps, SkillWrapperProps, ToggleSwitchProps, playPing() (+15 more)

### Community 2 - "Teaching Mode & Agent Logs"
Cohesion: 0.08
Nodes (26): AgentSessionLog, TeachingModeUI, TeachingModeUI.handleCaptureScreenshot, TeachingModeUI.handleSave, Fine-tune JSONL dataset, httpDelete(), httpGet(), httpPost() (+18 more)

### Community 3 - "Chat & Status Card UI"
Cohesion: 0.08
Nodes (27): AgentSessionLog(), AgentSessionLogProps, badge(), formatTime(), header, mono, overlay, panel (+19 more)

### Community 4 - "Realtime Voice Turn"
Cohesion: 0.12
Nodes (29): Azure Realtime WebSocket proxy, 30s hard-cap listening window, AsyncJobKind, clearListeningWindow(), connectRealtime(), ensureAudioContext(), finishResponse(), handleMessage() (+21 more)

### Community 5 - "TV Camera & Gesture Capture"
Cohesion: 0.12
Nodes (12): MEDIA_PLAYER_ENTITIES, REMOTE_ENTITIES, styles, TeachingModeUIProps, TeachingStep, TV_TOOLS, GestureEvent, HandGestureDetectorProps (+4 more)

### Community 6 - "Skill Toggles & Scheduled Tasks"
Cohesion: 0.14
Nodes (17): SkillToggles, SkillWrapper, ToggleSwitch, Backend HTTP API (localhost:3005), cancelRecurrenceFamily(), cancelScheduledTask(), listScheduledTasks(), ScheduledTask (+9 more)

### Community 7 - "Message History & Sessions"
Cohesion: 0.12
Nodes (5): MessageHistory, MessageHistoryStats, Message, MessageHistory, MessageHistoryManager

### Community 8 - "TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, allowJs, allowSyntheticDefaultImports, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+9 more)

### Community 9 - "App Bootstrap & Wake Word Flow"
Cohesion: 0.21
Nodes (12): TTS echo suppression strategy, Wake word -> voice turn flow, HTML entry point, App component (root), App test, Chat component, React DOM entry (index.tsx), Agentic flow & teaching types (+4 more)

### Community 10 - "PWA Manifest"
Cohesion: 0.25
Nodes (7): background_color, display, icons, name, short_name, start_url, theme_color

### Community 11 - "TTS Echo Filter"
Cohesion: 0.46
Nodes (7): Announcement, isLikelyEcho(), normalize(), noteAnnouncement(), prune(), recent, tokenize()

### Community 12 - "Speech Credentials & Camera Decision"
Cohesion: 0.40
Nodes (5): RTSP vs on-device camera capture mode, Webpack config override (browser polyfills), ha-voice-assistant package, getSpeechCredentials (axios), TvCameraController (screenshots)

### Community 14 - "React Logo Assets"
Cohesion: 0.67
Nodes (3): App Icon 192px (React Logo), PWA Manifest Icon Asset, React Atom Branding Mark

## Knowledge Gaps
- **140 isolated node(s):** `name`, `version`, `private`, `@mediapipe/camera_utils`, `@mediapipe/hands` (+135 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Message` connect `App Bootstrap & Wake Word Flow` to `UI Chrome & TTS Output`, `Chat & Status Card UI`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `TvCameraController` connect `TV Camera & Gesture Capture` to `Teaching Mode & Agent Logs`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _140 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `NPM Dependencies & Build` be split into smaller, more focused modules?**
  _Cohesion score 0.045454545454545456 - nodes in this community are weakly interconnected._
- **Should `UI Chrome & TTS Output` be split into smaller, more focused modules?**
  _Cohesion score 0.07557354925775979 - nodes in this community are weakly interconnected._
- **Should `Teaching Mode & Agent Logs` be split into smaller, more focused modules?**
  _Cohesion score 0.08253968253968254 - nodes in this community are weakly interconnected._
- **Should `Chat & Status Card UI` be split into smaller, more focused modules?**
  _Cohesion score 0.08143939393939394 - nodes in this community are weakly interconnected._