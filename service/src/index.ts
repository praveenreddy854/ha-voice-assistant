import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs";
import path from "path";
import {
  HOME_ASSISTANT_URL,
  HOME_ASSISTANT_TOKEN,
  SPEECH_KEY,
  SPEECH_REGION,
  VACUUM_CLEANER_ENTITY_ID,
} from "./config";
import { getHACommandBody } from "./ha";
import { classifyIntent } from "./intent";
import { processReminderRequest } from "./reminder";

// Global declaration for announcement storage
declare global {
  var pendingAnnouncement: string | null;
}

const app = express();
const port = process.env.PORT || 3005;

// File paths for storage
const REMINDERS_FILE = path.join(__dirname, "../generated_data/reminders.json");
const PROCESSED_REMINDERS_FILE = path.join(
  __dirname,
  "../generated_data/processed_reminders.json"
);

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, "../data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
      const { userPrompt: prompt, messageHistory } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "User prompt is required" });
      }
      const intent = await classifyIntent(prompt, messageHistory);
      res.json(intent);
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
      const { command, messageHistory } = req.body;
      const haBody = await getHACommandBody(command, messageHistory);
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
      console.log(`Received command: ${command}; Response:`, haResponse.data);
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

// Endpoint to check laundry switch status
app.get("/api/laundry-status", (req, res, next) => {
  (async () => {
    try {
      const entityId = "switch.laundry_switch";
      const response = await axios.get(
        `${HOME_ASSISTANT_URL}/api/states/${entityId}`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      const state = response.data as any;
      res.json({
        entity_id: entityId,
        state: state.state,
        last_changed: state.last_changed,
        last_updated: state.last_updated,
        attributes: state.attributes,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking laundry status:", err);
      res.status(500).json({
        error: "Error checking laundry status",
        message: err.message,
      });
    }
  })();
});

// Endpoint to check vacuum status
app.get("/api/vacuum-status", (req, res, next) => {
  (async () => {
    try {
      const entityId = VACUUM_CLEANER_ENTITY_ID;
      const response = await axios.get(
        `${HOME_ASSISTANT_URL}/api/states/${entityId}`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      const state = response.data as any;
      res.json({
        entity_id: entityId,
        state: state.state,
        last_changed: state.last_changed,
        last_updated: state.last_updated,
        attributes: state.attributes,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking vacuum status:", err);
      res.status(500).json({
        error: "Error checking vacuum status",
        message: err.message,
      });
    }
  })();
});

// Unified endpoint to process all reminder requests (CREATE, LIST, QUERY)
app.post("/api/processReminder", (req, res, next) => {
  (async () => {
    try {
      const { userPrompt, reminders, messageHistory } = req.body;
      if (!userPrompt) {
        return res.status(400).json({ error: "User prompt is required" });
      }
      if (!reminders || !Array.isArray(reminders)) {
        return res.status(400).json({ error: "Reminders array is required" });
      }

      const reminderData = await processReminderRequest(userPrompt, reminders, messageHistory);

      if (reminderData.action === "CREATE") {
        // Handle reminder creation
        const reminderId =
          Date.now().toString(36) + Math.random().toString(36).substring(2);

        const reminder = {
          id: reminderId,
          ...reminderData,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          notificationSent: false,
        };

        res.json({
          success: true,
          action: "CREATE",
          reminder,
          message: `Reminder created: ${reminder.title} at ${new Date(
            reminder.dueDate
          ).toLocaleString()}`,
        });

        console.log("Reminder created:", reminder);
      } else if (reminderData.action === "LIST") {
        // Handle reminder listing with intelligent filtering
        let filteredReminders = reminders.filter((r) => r.status === "active");
        const now = new Date();

        // Handle intelligent prioritization from LLM
        if (reminderData.prioritizeOverdue) {
          const overdueReminders = filteredReminders.filter(
            (r) => new Date(r.dueDate) < now
          );
          const upcomingReminders = filteredReminders.filter(
            (r) => new Date(r.dueDate) >= now
          );

          overdueReminders.sort(
            (a: any, b: any) =>
              new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
          );

          upcomingReminders.sort((a: any, b: any) => {
            const priorityOrder: { [key: string]: number } = {
              urgent: 0,
              high: 1,
              medium: 2,
              low: 3,
            };
            const aPriority = priorityOrder[a.priority] || 2;
            const bPriority = priorityOrder[b.priority] || 2;

            if (aPriority !== bPriority) {
              return aPriority - bPriority;
            }
            return (
              new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
            );
          });

          filteredReminders = [...overdueReminders, ...upcomingReminders];
        } else {
          filteredReminders.sort((a: any, b: any) => {
            const priorityOrder: { [key: string]: number } = {
              urgent: 0,
              high: 1,
              medium: 2,
              low: 3,
            };
            const aPriority = priorityOrder[a.priority] || 2;
            const bPriority = priorityOrder[b.priority] || 2;

            if (aPriority !== bPriority) {
              return aPriority - bPriority;
            }
            return (
              new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
            );
          });
        }

        if (reminderData.limit) {
          filteredReminders = filteredReminders.slice(0, reminderData.limit);
        }

        let message = "";
        if (reminderData.intelligentSuggestion) {
          message = reminderData.intelligentSuggestion;
          if (filteredReminders.length > 0) {
            message += " ";
            filteredReminders.forEach((reminder, index) => {
              const dueDate = new Date(reminder.dueDate);
              const isOverdue = dueDate < now;
              const timeStr =
                dueDate.toLocaleDateString() +
                " at " +
                dueDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              const overdueTag = isOverdue ? " (OVERDUE)" : "";
              message += `${index + 1}. ${
                reminder.title
              } - ${timeStr}${overdueTag}. `;
            });
          }
        } else {
          if (filteredReminders.length === 0) {
            message = "You have no active reminders.";
          } else {
            const count = reminderData.limit
              ? `top ${Math.min(reminderData.limit, filteredReminders.length)}`
              : "all";
            message = `Here are your ${count} reminders: `;

            filteredReminders.forEach((reminder, index) => {
              const dueDate = new Date(reminder.dueDate);
              const timeStr =
                dueDate.toLocaleDateString() +
                " at " +
                dueDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              message += `${index + 1}. ${reminder.title} - ${timeStr}. `;
            });
          }
        }

        res.json({
          success: true,
          action: "LIST",
          reminders: filteredReminders,
          message,
        });
      } else if (reminderData.action === "QUERY") {
        // Handle reminder queries with filtering
        let filteredReminders = reminders.filter((r) => r.status === "active");

        if (reminderData.category) {
          filteredReminders = filteredReminders.filter(
            (r) => r.category === reminderData.category
          );
        }

        if (reminderData.dateFilter) {
          const today = new Date();
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);

          if (reminderData.dateFilter === "tomorrow") {
            filteredReminders = filteredReminders.filter((r) => {
              const reminderDate = new Date(r.dueDate);
              return reminderDate.toDateString() === tomorrow.toDateString();
            });
          }
        }

        let message = "";
        if (reminderData.intelligentSuggestion) {
          message = reminderData.intelligentSuggestion;
          if (filteredReminders.length > 0) {
            message += " ";
            filteredReminders.forEach((reminder, index) => {
              const dueDate = new Date(reminder.dueDate);
              const now = new Date();
              const isOverdue = dueDate < now;
              const timeStr =
                dueDate.toLocaleDateString() +
                " at " +
                dueDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              const overdueTag = isOverdue ? " (OVERDUE)" : "";
              message += `${index + 1}. ${
                reminder.title
              } - ${timeStr}${overdueTag}. `;
            });
          }
        } else {
          if (filteredReminders.length === 0) {
            if (reminderData.category) {
              message = `You have no ${reminderData.category} reminders.`;
            } else if (reminderData.dateFilter) {
              message = `You have no reminders for ${reminderData.dateFilter}.`;
            } else {
              message = "No reminders found matching your criteria.";
            }
          } else {
            if (reminderData.category) {
              message = `You have ${filteredReminders.length} ${
                reminderData.category
              } reminder${filteredReminders.length > 1 ? "s" : ""}: `;
            } else {
              message = `Found ${filteredReminders.length} reminder${
                filteredReminders.length > 1 ? "s" : ""
              }: `;
            }

            filteredReminders.forEach((reminder, index) => {
              const dueDate = new Date(reminder.dueDate);
              const timeStr =
                dueDate.toLocaleDateString() +
                " at " +
                dueDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              message += `${index + 1}. ${reminder.title} - ${timeStr}. `;
            });
          }
        }

        res.json({
          success: true,
          action: "QUERY",
          reminders: filteredReminders,
          message,
        });
      }

      console.log("Reminder processed:", reminderData);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error processing reminder:", err);
      res.status(500).json({
        error: "Error processing reminder",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

// Endpoint to read reminders from JSON file
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/reminders", (req, res, next) => {
  try {
    if (fs.existsSync(REMINDERS_FILE)) {
      const data = fs.readFileSync(REMINDERS_FILE, "utf8");
      const reminders = JSON.parse(data);
      res.json(reminders);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error("Error reading reminders:", error);
    res.status(500).json({ error: "Failed to read reminders" });
  }
});

// Endpoint to write reminders to JSON file
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/reminders", (req, res, next) => {
  (async () => {
    try {
      const { reminders } = req.body;
      if (!Array.isArray(reminders)) {
        return res.status(400).json({ error: "Reminders must be an array" });
      }

      fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
      res.json({ success: true, message: "Reminders saved successfully" });
    } catch (error) {
      console.error("Error writing reminders:", error);
      res.status(500).json({ error: "Failed to save reminders" });
    }
  })();
});

// Endpoint to read processed reminders from JSON file
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/processed-reminders", (req, res, next) => {
  try {
    if (fs.existsSync(PROCESSED_REMINDERS_FILE)) {
      const data = fs.readFileSync(PROCESSED_REMINDERS_FILE, "utf8");
      const processedReminders = JSON.parse(data);
      res.json(processedReminders);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error("Error reading processed reminders:", error);
    res.status(500).json({ error: "Failed to read processed reminders" });
  }
});

// Endpoint to write processed reminders to JSON file
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/processed-reminders", (req, res, next) => {
  (async () => {
    try {
      const { processedReminders } = req.body;
      if (!Array.isArray(processedReminders)) {
        return res
          .status(400)
          .json({ error: "Processed reminders must be an array" });
      }

      fs.writeFileSync(
        PROCESSED_REMINDERS_FILE,
        JSON.stringify(processedReminders, null, 2)
      );
      res.json({
        success: true,
        message: "Processed reminders saved successfully",
      });
    } catch (error) {
      console.error("Error writing processed reminders:", error);
      res.status(500).json({ error: "Failed to save processed reminders" });
    }
  })();
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Visit http://localhost:${port} to access the application`);
});
