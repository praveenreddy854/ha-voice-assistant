# Home Assistant Voice Assistant

A modern voice-controlled smart home assistant that integrates with Home Assistant to control your smart devices through natural language voice commands. The application features a React-based frontend for user interaction and a Node.js backend service for processing commands and communicating with Home Assistant.

## 🛠️ Technology Stack

### Frontend (ha-voice-assistant/)

- **React 19** with TypeScript
- **Azure Cognitive Services Speech SDK** for voice processing
- **Axios** for HTTP requests
- **React Speech Recognition** for browser-based speech recognition
- **Create React App** with custom webpack configuration

### Backend (service/)

- **Node.js** with Express and TypeScript
- **Azure OpenAI** for natural language processing
- **Home Assistant REST API** integration
- **CORS** enabled for cross-origin requests

## 🚀 Getting Started

### Prerequisites

1. **Home Assistant** instance running and accessible
2. **Azure Cognitive Services** account for speech services
3. **Azure OpenAI** or **OpenAI API** access
4. **Node.js** (v16 or higher)
5. **npm** or **yarn**

### Environment Configuration

Create `.env` files in both `ha-voice-assistant/` and `service/` directories:

#### Frontend Environment (`ha-voice-assistant/.env`)

```env
REACT_APP_API_BASE_URL=http://localhost:3005
```

#### Backend Environment (`service/.env`)

```env
HOME_ASSISTANT_URL=http://your-ha-instance:8123
HOME_ASSISTANT_TOKEN=your_ha_long_lived_access_token
SPEECH_KEY=your_azure_speech_key
SPEECH_REGION=your_azure_speech_region
API_KEY=your_openai_or_azure_openai_key
OPEN_AI_BASE_URL=your_azure_openai_endpoint
AZURE_OPENAI_API_DEPLOYMENT_NAME=your_deployment_name
OPENAI_RESPONSES_API_VERSION=2024-02-15-preview
```

### Installation & Setup

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd ha-voice-assistant
   ```

2. **Install dependencies for both projects**

   ```bash
   # Install frontend dependencies
   cd ha-voice-assistant
   npm install

   # Install backend dependencies
   cd ../service
   npm install
   ```

3. **Build the backend service**
   ```bash
   cd service
   npm run build
   ```

### Running the Application

#### Development Mode

1. **Start the backend service**

   ```bash
   cd service
   npm run dev
   ```

   The backend will run on `http://localhost:3005`

2. **Start the frontend application**
   ```bash
   cd ha-voice-assistant
   npm start
   ```
   The frontend will run on `http://localhost:3000`

#### Production Mode

1. **Build and start backend**

   ```bash
   cd service
   npm run build
   npm start
   ```

2. **Build and serve frontend**
   ```bash
   cd ha-voice-assistant
   npm run build
   # Serve the build folder with your preferred web server
   ```

## 🎯 Usage

1. **Open the application** in your browser at `http://localhost:3000`
2. **Click the start speech recognition button** and say the wake word "assistant" or "hey assistant" to start voice recognition. This uses react-speech-recognition package for continuous listening for wake word detection. Once wake word is detected, we use Azure speech services to convert your speech to text.
3. **Speak your command** naturally, such as:
   - "Turn on the living room lights"
   - "Set the thermostat to 72 degrees"
   - "Play music on Apple TV"
   - "Turn off all lights"
4. **Receive confirmation** through both text and voice responses
5. **Chat mode** for general conversation when not issuing device commands

## 🏠 Home Assistant Integration

The application integrates with Home Assistant through:

- **REST API calls** for device state retrieval and control
- **Entity discovery** to understand available devices
- **State management** for real-time device status
- **Service calls** for executing device commands

### Supported Device Types

- Lights and switches
- Media players (Apple TV, etc.)
- Climate control (thermostats)
- Sensors and binary sensors
- Custom automations and scripts

## 🤖 AI-Powered Features

### Intent Classification

The system uses AI to classify user input into two categories:

- **HACommand**: Home Assistant device control requests
- **Chat**: General conversation and questions

### Natural Language Processing

- Converts natural language commands into Home Assistant API calls
- Understands context and device relationships
- Handles variations in command phrasing

## 🔧 API Endpoints

### Backend Service Endpoints

- `GET /` - Health check
- `POST /api/classifyIntent` - Classify user intent (HACommand vs Chat)
- `POST /api/postHACommand` - Execute Home Assistant commands

## 📝 Development

### Adding New Features

1. **Frontend changes**: Modify components in `ha-voice-assistant/src/`
2. **Backend changes**: Update services in `service/src/`
3. **New device types**: Update prompts in `service/src/prompts/`
4. **Configuration**: Modify config files for new environment variables

### Testing

```bash
# Frontend tests
cd ha-voice-assistant
npm test

# Backend tests (if implemented)
cd service
npm test
```

## 🔐 Security Considerations

- Store sensitive credentials in environment variables
- Use HTTPS in production
- Implement proper CORS policies
- Secure Home Assistant with proper authentication
- Consider rate limiting for API endpoints

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- **Microsoft Azure Cognitive Services** for speech processing
- **OpenAI** for natural language understanding
- **Home Assistant** community for the excellent smart home platform
- **React** and **Node.js** communities for the robust frameworks

---

**Note**: This is a development project. Ensure proper security measures are in place before deploying to production environments.
