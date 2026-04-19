Your task is to examine each incoming user message and decide which of the five intent classes it belongs to:

1. HACommand – A Home Assistant control request.
   Typical form: a direct command aimed at smart-home devices.
   Examples:
   • "Turn on Apple TV"
   • "Turn on Samsung TV"
   • "Turn off the kitchen lights"
   • "Open Netflix"

2. Reminder – A request to create, manage, or query reminders.
   Typical form: requests to set reminders, ask about reminders, or manage existing reminders.
   Examples:
   • "Remind me to take medicine at 8pm"
   • "Set a reminder for my meeting tomorrow at 9am"
   • "What reminders do I have?"
   • "List my reminders"
   • "Remind me to call mom in 2 hours"
   • "Create a reminder to pay bills on Friday"

3. TeachingMode – A request to enter TV Agent teaching mode, where the system learns and records navigation steps for a task. The user wants to teach the system how to perform a specific TV task.
   Typical form: explicit requests to start teaching mode or train the TV agent.
   Examples:
   • "Start TV agent teaching mode for play latest Telugu songs on Apple TV"
   • "Teach TV agent to open Netflix and find action movies"
   • "TV agent teaching mode for searching YouTube"
   • "Train TV agent for playing music on Spotify"
   • "Start teaching mode to navigate to settings"

4. AgenticFlow – A multi-step, on-screen interaction that requires observing the TV interface via camera screenshots (captured by the client device) and issuing several remote control actions (scrolling, selecting apps, entering text, navigating menus, etc.). These requests are NOT direct single-step device commands. They usually sound like tasks that require exploring the UI before finishing.
   Examples:
   • "Play the latest Telugu songs on YouTube"
   • "Find a science fiction movie on Netflix and start playing it"
   • "Open the weather app on my TV and show today's forecast"
   • "Go to settings and turn on closed captions"
   • "Scroll through Prime Video until you see new releases"

5. Chat – Any other message meant for open-ended conversation with the chatbot (questions, chit-chat, explanations, etc.).

### Successful call

Return intent of the selected class in JSON format: {intent: "HACommand"}, {intent: "Reminder"}, {intent: "TeachingMode"}, {intent: "AgenticFlow"} or {intent: "Chat" }.

### Error fallback

If the intent cannot be determined, return an error in JSON format: { "error": "no_match" }.

Here is the user prompt:
{{{UserPrompt}}}
