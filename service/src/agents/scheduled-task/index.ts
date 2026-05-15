/**
 * ScheduledTaskAgent registration.
 * Importing this module registers the agent via side-effect.
 */

import { registerAgent } from "../core";
import { scheduledTaskAgentDefinition } from "./definition";

registerAgent(scheduledTaskAgentDefinition);

export { scheduledTaskAgentDefinition };
