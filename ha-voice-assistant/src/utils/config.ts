import axios from "axios";

// Define constants for Azure OpenAI API
export const USE_AZURE_SPEECH = true;

export const getSpeechCredentials = async () => {
  try {
    const response = await axios.get(
      "http://localhost:3005/api/get-speech-credentials"
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching speech credentials:", error);
    throw error;
  }
};
