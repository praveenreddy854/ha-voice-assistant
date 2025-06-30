import { httpPost } from "./httpUtils";

export async function postHaCommand(command: string): Promise<any> {
  try {
    const response = await httpPost(
      "/postHACommand",
      { command },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error posting command to Home Assistant:", error);
    throw new Error(
      `Failed to post command to Home Assistant: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
