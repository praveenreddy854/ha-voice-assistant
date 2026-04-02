/**
 * TV Navigation Agent - Main Export
 *
 * Specialized agent for TV navigation operations including:
 * - go_home: Navigate to TV home screen
 * - go_back: Go back to previous screen
 * - navigate: Move in directional patterns (up/down/left/right)
 * - find_search: Intelligently locate and activate search using vision AI
 * - click_select_button: Press select to activate highlighted item
 * - request_screenshot: Request screenshot for visual feedback
 * - wait: Pause for UI animations
 */

export { runNavigationAgent } from "./navigationAgent";

export {
  NAV_AGENT_NAME,
  NAV_AGENT_DESCRIPTION,
  NAV_AGENT_INSTRUCTIONS,
  NAV_AGENT_MAX_ITERATIONS_CAP,
  NAV_TOOLS,
} from "./constants";

export type {
  GoHomeArgs,
  GoBackArgs,
  NavigateArgs,
  FindSearchArgs,
  ClickSelectButtonArgs,
  RequestScreenshotArgs,
  WaitArgs,
  NavToolName,
  NavToolArguments,
  NavAgentStep,
  NavAgentSessionState,
  NavAgenticFlowResult,
  RunNavAgenticFlowOptions,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
