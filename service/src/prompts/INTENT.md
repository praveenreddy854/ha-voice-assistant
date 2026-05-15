Your task is to examine each incoming user message and decide which of the five intent classes it belongs to:

1. HACommand – A Home Assistant control request that should execute IMMEDIATELY (no scheduling).
   Typical form: a direct command aimed at smart-home devices, with no future time mentioned.
   Examples:
   • "Turn on Apple TV"
   • "Turn on Samsung TV"
   • "Turn off the kitchen lights"
   • "Open Netflix"

2. ScheduledTask – Any request to schedule a future action or future announcement, list scheduled tasks, or query about scheduled tasks. Both spoken-message reminders ("remind me…") and time-deferred device actions ("start vacuuming at 9 AM") are ScheduledTask. The presence of a future time, recurrence phrase, or the word "remind" strongly indicates ScheduledTask.
   Examples:
   • "Remind me to take medicine at 8pm"
   • "Set a reminder for my meeting tomorrow at 9am"
   • "Start vacuuming at 9 AM tomorrow"
   • "Turn off the kitchen lights at midnight every day"
   • "Charge my Tesla every night at 11pm"
   • "What scheduled tasks do I have today?"
   • "List my reminders"
   • "Cancel the vacuum schedule"

3. TeachingMode – A request to enter TV Agent teaching mode, where the system learns and records navigation steps for a task. The user wants to teach the system how to perform a specific TV task.
   Typical form: explicit requests to start teaching mode or train the TV agent.
   Examples:
   • "Start TV agent teaching mode for play latest Telugu songs on Apple TV"
   • "Teach TV agent to open Netflix and find action movies"
   • "TV agent teaching mode for searching YouTube"
   • "Train TV agent for playing music on Spotify"
   • "Start teaching mode to navigate to settings"

4. AgenticFlow – A multi-step, on-screen TV interaction that requires navigating the TV UI via remote control actions (scrolling, selecting apps, entering text, navigating menus, etc.). The request must clearly involve controlling or navigating a TV/streaming app interface. These are NOT general knowledge questions — they are tasks that require exploring the TV UI before finishing.
   Examples:
   • "Play the latest Telugu songs on YouTube"
   • "Find a science fiction movie on Netflix and start playing it"
   • "Go to settings and turn on closed captions"
   • "Scroll through Prime Video until you see new releases"
   • "Search for cooking videos on YouTube"

5. Chat – Questions, general knowledge, chit-chat, or any conversational message that does NOT involve controlling a smart-home device or navigating a TV interface. This includes questions about weather, news, facts, explanations, opinions, math, and anything else that is purely informational.
   Examples:
   • "How is the weather"
   • "What time is it"
   • "Tell me a joke"
   • "What is the capital of France"
   • "Who won the game last night"
   • "What should I cook for dinner"
   • "Explain quantum computing"

### Successful call

Return intent of the selected class in JSON format: {intent: "HACommand"}, {intent: "ScheduledTask"}, {intent: "TeachingMode"}, {intent: "AgenticFlow"} or {intent: "Chat" }.

### Error fallback

If the intent cannot be determined, return an error in JSON format: { "error": "no_match" }.

Here is the user prompt:
{{{UserPrompt}}}
