import {
  CommandExecutionResult,
  homeAssistantService,
  ChatMessage,
} from "./services/homeAssistantService";
import { HassServiceCommandBody, HassState } from "./types/ha";

export async function getHACommandBody(
  command: string,
  messageHistory?: ChatMessage[]
): Promise<HassServiceCommandBody> {
  return homeAssistantService.getHACommandBody(command, messageHistory);
}

export async function fetchAllStates(): Promise<HassState[]> {
  return homeAssistantService.fetchAllStates();
}

export const getKnownDevices = async (): Promise<string[]> => {
  return homeAssistantService.getKnownDevices();
};

export const matchesKnownDevice = (
  entityFragment: string,
  knownDevices: string[],
  fullEntityId?: string
): boolean => {
  return homeAssistantService.matchesKnownDevice(
    entityFragment,
    knownDevices,
    fullEntityId
  );
};

export const getKnownDeviceStates = async (): Promise<HassState[]> => {
  return homeAssistantService.getKnownDeviceStates();
};

export async function executeHACommand(
  command: string,
  messageHistory?: ChatMessage[]
): Promise<CommandExecutionResult> {
  return homeAssistantService.executeNaturalLanguageCommand(
    command,
    messageHistory
  );
}
