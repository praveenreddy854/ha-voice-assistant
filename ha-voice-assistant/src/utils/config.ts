import axios from "axios";

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
