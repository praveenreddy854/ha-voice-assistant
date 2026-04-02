/**
 * Agent Registry
 *
 * Central registry for agent definitions. Register an agent once at
 * startup and the orchestrator + API layer can look it up by ID.
 */

import { AgentDefinition, AgentType } from "./types";

const agents = new Map<AgentType, AgentDefinition>();

/**
 * Register an agent definition.
 * Throws if an agent with the same ID is already registered.
 */
export function registerAgent(definition: AgentDefinition): void {
  if (agents.has(definition.id)) {
    throw new Error(
      `Agent "${definition.id}" is already registered. Use a unique ID.`
    );
  }
  agents.set(definition.id, definition);
  console.log(`[AgentRegistry] Registered agent: ${definition.id} (${definition.name})`);
}

/**
 * Get an agent definition by ID.
 * Returns undefined if not found.
 */
export function getAgent(agentType: AgentType): AgentDefinition | undefined {
  return agents.get(agentType);
}

/**
 * Get all registered agent types.
 */
export function getRegisteredAgentTypes(): AgentType[] {
  return Array.from(agents.keys());
}

/**
 * Get all registered agent definitions.
 */
export function getAllAgents(): AgentDefinition[] {
  return Array.from(agents.values());
}
