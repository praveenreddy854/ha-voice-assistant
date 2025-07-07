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
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
