# CLAUDE

## Folders

• ha-voice-assistant/ – React (front-end)
• server/ – Node.js (back-end)

## Run

npm i # install deps
npm --filter ha-voice-assistant dev # start front-end
npm --filter server dev # start back-end

## About this Project

A modern voice-controlled smart home assistant that integrates with Home Assistant to control your smart devices through natural language voice commands. The application features a React-based frontend for user interaction and a Node.js backend service for processing commands and communicating with Home Assistant.

### Speech Recognition and Command Processing

This is a single page application with a button to start listening for wake words, and then it listens for commands. The backend processes these commands using Azure OpenAI and communicates with Home Assistant to control devices.

For wake word detection, the application uses react-speech-recognition for browser-based speech recognition, and for command voice processing, it utilizes the Azure Cognitive Services Speech SDK.

### Auto stop listening

The application automatically stops listening after a command to reduces the COGS usage of azure speech services. This is done by setting a timeout after a wake word is detected. After the timeout, the application will stop listening for commands and wait for the next wake word.

## Claude CLI Rules

1. Stay inside the correct folder (front-end vs back-end).
2. Front-end never calls Home Assistant directly—use the server API.
3. Use TypeScript everywhere.
