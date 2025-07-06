import express from "express";
import axios from "axios";
import cors from "cors";
import {
  HOME_ASSISTANT_URL,
  HOME_ASSISTANT_TOKEN,
  SPEECH_KEY,
  SPEECH_REGION,
} from "./config";
import { getHACommandBody } from "./ha";
import { classifyIntent } from "./intent";

const app = express();
const port = process.env.PORT || 3005;

// Middleware to parse JSON bodies
app.use(express.json());
app.use(cors());

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/", (req, res, next) => {
  res.send("Hello, Node.js + TypeScript!");
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/classifyIntent", (req, res, next) => {
  (async () => {
    try {
      const { userPrompt: prompt } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "User prompt is required" });
      }
      const intent = await classifyIntent(prompt);
      res.json({ intent });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error classifying intent:", err);
      res.status(500).json({
        error: "Error classifying intent",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/postHACommand", (req, res, next) => {
  (async () => {
    try {
      const { command } = req.body;
      const haBody = await getHACommandBody(command);
      let urlPath = haBody.url_path;
      const entityId = haBody.entity_id;

      if (!urlPath || urlPath.split("/").length !== 2) {
        return res.status(400).json({
          error: "Invalid services home assistant path",
          message:
            "Command body must contain a valid 'url_path' in the format '<domain>/<service>'",
        });
      }

      if (!entityId) {
        return res.status(400).json({
          error: "Missing entity_id",
          message: "Command body must contain 'entity_id'",
        });
      }

      // Remove leading and trailing slashes from the URL path
      if (urlPath.startsWith("/")) {
        urlPath = urlPath.substring(1);
      }

      // Prepare the request body
      const requestBody: any = { entity_id: haBody.entity_id };

      // Add service_data if present (for play_media and other services that need additional data)
      if (haBody.service_data) {
        // For Home Assistant API, merge service_data fields directly at the top level
        Object.assign(requestBody, haBody.service_data);
      }

      const haResponse = await axios.post(
        `${HOME_ASSISTANT_URL}/api/services/${urlPath}`,
        requestBody,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
          },
        }
      );

      if (haResponse.status < 200 || haResponse.status >= 300) {
        const errorText = haResponse.data;
        console.error("Home Assistant error response:", errorText);
      }

      res.json({
        success: true,
        message: `Command ${command} sent successfully`,
      });
      console.log("Received command to post to Home Assistant:", command);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error posting command to Home Assistant:", err);
      res.status(500).json({
        error: "Error posting command to Home Assistant",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/get-speech-token", (req, res, next) => {
  (async () => {
    try {
      if (!SPEECH_KEY) {
        return res.status(400).json({
          error: "Azure Speech Service key is not configured",
        });
      }
      // Token endpoint for Speech Services
      const tokenEndpoint = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
      const response = await axios({
        method: "post",
        url: tokenEndpoint,
        headers: {
          "Ocp-Apim-Subscription-Key": SPEECH_KEY,
          "Content-Type": "application/json",
        },
      });
      res.json({
        token: response.data,
        region: SPEECH_REGION,
      });
    } catch (error) {
      // Allow for err.response (from axios)
      const err =
        error && typeof error === "object" && "message" in error
          ? (error as any)
          : new Error(String(error));
      console.error(
        "Error getting speech token:",
        err?.response?.data || err.message
      );
      res.status(err?.response?.status || 500).json({
        error: "Error retrieving token",
        details: err.message,
      });
    }
  })();
});

// New endpoint to check available services for a device
app.get("/api/check-device-services/:entity_id", (req, res, next) => {
  (async () => {
    try {
      const { entity_id } = req.params;
      // Get device state and attributes
      const deviceResponse = await fetch(
        `${HOME_ASSISTANT_URL}/api/states/${entity_id}`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!deviceResponse.ok) {
        throw new Error(`Failed to fetch device: ${deviceResponse.statusText}`);
      }

      const deviceState = await deviceResponse.json();

      // Get available services for media_player domain
      const servicesResponse = await fetch(
        `${HOME_ASSISTANT_URL}/api/services/media_player`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!servicesResponse.ok) {
        throw new Error(
          `Failed to fetch services: ${servicesResponse.statusText}`
        );
      }

      const services = await servicesResponse.json();

      res.json({
        device_state: deviceState,
        available_services: services,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking device services:", err);
      res.status(500).json({
        error: "Error checking device services",
        message: err.message,
      });
    }
  })();
});

// New endpoint to check available notify services
app.get("/api/check-notify-services", (req, res, next) => {
  (async () => {
    try {
      const servicesResponse = await fetch(
        `${HOME_ASSISTANT_URL}/api/services/notify`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!servicesResponse.ok) {
        throw new Error(
          `Failed to fetch notify services: ${servicesResponse.statusText}`
        );
      }

      const services = await servicesResponse.json();
      res.json({
        available_notify_services: services,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking notify services:", err);
      res.status(500).json({
        error: "Error checking notify services",
        message: err.message,
      });
    }
  })();
});

app.get("/api/get-speech-credentials", (req, res, next) => {
  (async () => {
    try {
      if (!SPEECH_KEY || !SPEECH_REGION) {
        return res.status(400).json({
          error: "Azure Speech Service key or region is not configured",
        });
      }
      res.json({
        speechKey: SPEECH_KEY,
        speechRegion: SPEECH_REGION,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error retrieving speech credentials:", err);
      res.status(500).json({
        error: "Error retrieving speech credentials",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Visit http://localhost:${port} to access the application`);
});
