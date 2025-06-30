Your task is to examine each incoming user message and decide which of the two intent classes it belongs to:

1. HACommand – A Home Assistant control request.
   Typical form: a direct command aimed at smart-home devices.
   Examples:
   • “Turn on Apple TV”
   • “Turn off the kitchen lights”
   • “Open Netflix”

2. Chat – Any other message meant for open-ended conversation with the chatbot (questions, chit-chat, explanations, etc.).

Return only the name of the selected class: HACommand or Chat.

Here is the user prompt:
{{{UserPrompt}}}
