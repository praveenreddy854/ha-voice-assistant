Your task is to examine each incoming user message and decide which of the three intent classes it belongs to:

1. HACommand – A Home Assistant control request.
   Typical form: a direct command aimed at smart-home devices.
   Examples:
   • "Turn on Apple TV"
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

3. Chat – Any other message meant for open-ended conversation with the chatbot (questions, chit-chat, explanations, etc.).

Return only the name of the selected class: HACommand, Reminder, or Chat.

Here is the user prompt:
{{{UserPrompt}}}
