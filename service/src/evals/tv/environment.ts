import sharp from "sharp";
import type { Evidence, Scenario } from "../types";
import { CONTENT, REFERENCE_DATE, type TvState } from "./scenarios";

const apps = ["YouTube", "Netflix", "Smart STB"];
const alphabet = ["#", "SPACE", ..."abcdefghijklmnopqrstuvwxyz", "DELETE"];
const escape = (text: string) => text.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
export class TvEnvironment {
  readonly state: TvState;
  readonly evidence: Evidence[] = [];
  researchRequired = false;
  virtualMs = 0;
  private memory: Record<string, unknown>[] = [];
  constructor(readonly scenario: Scenario<TvState>, readonly skills: Record<string, string> = {}) {
    this.state = structuredClone(scenario.initial);
    this.record({ kind: "initial", text: JSON.stringify(this.deviceStates()) });
  }
  record(item: Omit<Evidence, "id">): Evidence {
    const event = { id: `e${this.evidence.length + 1}`, timestamp: new Date().toISOString(), ...item };
    this.evidence.push(event); return event;
  }
  deviceStates() {
    const s = this.state, device = this.scenario.context.target, content = CONTENT.find(c => c.id === s.content);
    return [
      { entity_id: `remote.${device}`, state: s.unreachable ? "unavailable" : s.power ? "on" : "off", attributes: { friendly_name: device } },
      { entity_id: `media_player.${device}`, state: s.unreachable ? "unavailable" : !s.power ? "off" : s.playback === "idle" ? "on" : s.playback,
        attributes: { friendly_name: device, app_name: s.power ? s.app : undefined, media_title: content?.title, media_content_id: content?.id } },
    ];
  }
  taskSatisfied(): boolean {
    const s = this.state, task = this.scenario.context.task;
    if (!s.power || s.unreachable) return false;
    if (task === "pause") return s.playback === "paused";
    if (task === "resume") return s.playback === "playing";
    if (task === "play_latest_telugu_songs") return s.app === "YouTube" && s.content === "latest-telugu" && s.playback === "playing";
    return s.app === this.scenario.context.app;
  }
  async screenshot(): Promise<string> {
    const s = this.state;
    let body = `<rect width="1280" height="720" fill="#111827"/>`;
    const text = (x: number, y: number, value: string, size = 30) => `<text x="${x}" y="${y}" fill="white" font-family="sans-serif" font-size="${size}">${escape(value)}</text>`;
    const card = (x: number, y: number, w: number, label: string, selected: boolean) => `<rect x="${x}" y="${y}" width="${w}" height="72" rx="12" fill="${selected ? "#2563eb" : "#263449"}" stroke="${selected ? "white" : "#475569"}" stroke-width="3"/>${text(x + 12, y + 46, label, 22)}`;
    if (!s.power || s.unreachable) body = `<rect width="1280" height="720" fill="black"/>`;
    else {
      body += text(48, 65, s.screen === "home" ? "Apple TV / Samsung TV Home" : s.app, 36);
      if (s.screen === "home") apps.forEach((app, i) => { body += card(60 + i * 385, 210, 340, app, i === s.selection); });
      if (s.screen === "app") body += card(60, 180, 300, "Search", true);
      if (s.screen === "keyboard") {
        body += text(48, 150, `Search: ${s.query || "_"}`);
        alphabet.forEach((key, i) => { body += card(24 + i * 43, 240, 40, key === "SPACE" ? "_" : key === "DELETE" ? "⌫" : key, key === s.cursor); });
        body += text(48, 415, "Down: search results     Cursor highlighted above", 24);
      }
      if (s.screen === "results") {
        body += text(48, 125, `Search: ${s.query}`);
        CONTENT.forEach((content, i) => { body += card(50, 165 + i * 120, 1180, `${content.title} | ${content.language} | Released ${content.released}`, i === s.selection); });
        body += text(48, 620, `Catalog as of ${REFERENCE_DATE}`, 22);
      }
      if (s.screen === "playback") {
        body += text(65, 260, CONTENT.find(c => c.id === s.content)?.title || "No content", 40);
        body += text(65, 330, s.playback.toUpperCase());
      }
    }
    return `data:image/png;base64,${(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">${body}</svg>`)).png().toBuffer()).toString("base64")}`;
  }
  async execute(tool: string, args: Record<string, unknown>): Promise<{ observation: string; toolSuccess: boolean; image?: string }> {
    const start = Date.now(), s = this.state;
    let observation = "", toolSuccess = true, image: string | undefined;
    const fail = (message: string) => { observation = message; toolSuccess = false; };
    const command = ["click_power_button", "launch_app", "navigate", "click_select_button", "go_back", "go_home", "deterministic_typing", "delete_typed_text", "media_control"].includes(tool);
    const target = args.remote_entity_id || args.media_player_entity_id;
    if (target && target !== `remote.${this.scenario.context.target}` && target !== `media_player.${this.scenario.context.target}`) fail(`Unknown device ${target}; no command executed.`);
    else if (command && this.researchRequired) fail("Command research is required after failed verification. Call web_search for the device integration before retrying.");
    else if (command && s.unreachable) { fail("Device unavailable; power recovery failed. Research the device integration before retrying."); this.researchRequired = true; }
    else {
      if (command && tool !== "click_power_button" && !s.power) { s.power = true; observation += "Device state preflight: powered on successfully. "; }
      switch (tool) {
        case "get_device_state": observation += JSON.stringify(this.deviceStates()); break;
        case "get_latest_screenshot": image = await this.screenshot(); observation = "Current screen image attached."; break;
        case "click_power_button": s.power = args.desired_state === "on"; observation += JSON.stringify(this.deviceStates()); break;
        case "launch_app":
          if (s.failLaunch) { s.failLaunch = false; this.researchRequired = true; fail("Launch failed. Research this device integration before retrying or using remote navigation."); }
          else if (s.unconfirmed) { this.researchRequired = true; fail(`PARTIAL: command accepted, app remains ${s.app}. Research before retrying.`); }
          else if (!apps.includes(String(args.app_name))) fail("App not installed.");
          else { s.app = String(args.app_name); s.screen = "app"; s.selection = 0; s.playback = "idle"; s.content = undefined; observation += `App ready. ${JSON.stringify(this.deviceStates())}`; }
          break;
        case "go_home": s.screen = "home"; s.app = "Home"; s.selection = 0; s.playback = "idle"; s.content = undefined; observation += "Home screen displayed. Request a screenshot to inspect it."; break;
        case "go_back": s.screen = s.screen === "playback" ? "results" : "app"; s.playback = "idle"; s.selection = 0; observation += "Went back. Request a screenshot to inspect the current screen."; break;
        case "navigate": {
          const count = Number(args.count || 1), direction = String(args.direction);
          if (s.screen === "playback") { fail("Playback is fullscreen. Go back before navigating."); break; }
          if (s.screen === "keyboard") {
            if (direction === "down") { s.screen = "results"; s.selection = 0; }
            else { const i = alphabet.indexOf(s.cursor); s.cursor = alphabet[Math.max(0, Math.min(28, i + (direction === "left" ? -count : count)))]; }
          } else if (s.screen === "results" && direction === "up" && s.selection === 0) s.screen = "keyboard";
          else if (s.screen === "results" || s.screen === "home") s.selection = Math.max(0, Math.min(2, s.selection + (["down", "right"].includes(direction) ? count : -count)));
          observation += "Navigation complete. Request a screenshot for focus position."; break;
        }
        case "click_select_button":
          if (s.screen === "home") {
            if (s.unconfirmed) { this.researchRequired = true; fail("App did not open; still on home screen. Research before retrying."); }
            else { s.app = apps[s.selection]; s.screen = "app"; s.selection = 0; }
          } else if (s.screen === "app") { s.screen = "keyboard"; s.cursor = "a"; }
          else if (s.screen === "keyboard") s.query += s.cursor === "SPACE" ? " " : s.cursor;
          else if (s.screen === "results") { s.content = CONTENT[s.selection].id; s.screen = "playback"; s.playback = s.loadsPaused ? "paused" : "playing"; }
          observation ||= "Selection complete. Inspect the screen or device state to verify."; break;
        case "deterministic_typing":
          if (s.screen !== "keyboard") fail("Keyboard is not visible; inspect the screen before typing.");
          else if (String(args.current_cursor_position).toLowerCase() !== s.cursor.toLowerCase()) fail("Cursor does not match the visible keyboard. No text entered.");
          else if (s.query && args.already_typed !== s.query) fail("Existing query differs; inspect the text and supply already_typed.");
          else { s.query = String(args.text); s.cursor = s.query.slice(-1).toLowerCase() || "a"; image = await this.screenshot(); observation = "Text entered. Inspect the returned screenshot before moving to results."; }
          break;
        case "delete_typed_text": s.query = ""; s.cursor = "DELETE"; observation = "Search text cleared."; break;
        case "media_control":
          if (!s.content) fail("No media selected.");
          else if (["play", "pause", "stop"].includes(String(args.action))) { s.playback = args.action === "play" ? "playing" : args.action === "pause" ? "paused" : "idle"; observation += JSON.stringify(this.deviceStates()); }
          else fail("This media operation is unsupported by the fixture.");
          break;
        case "wait": this.virtualMs += Number(args.duration_ms || 1500); observation = `Waited ${Number(args.duration_ms || 1500)} simulated milliseconds.`; break;
        case "load_skill": observation = this.skills[String(args.skill_key)] || "Skill not available."; toolSuccess = Boolean(this.skills[String(args.skill_key)]); break;
        case "web_search": this.researchRequired = false; observation = "Fixture integration reference: launch apps through media_player.select_source. Apple TV remote supports home, menu, select and directional keys; wake with remote.turn_on. Verify app/playback using media_player state. Samsung app launch uses its application source. An unavailable device cannot acknowledge power recovery; report failure if it remains unreachable."; break;
        case "retrieve_similar_flows": observation = "No matching execution history in this fixture."; break;
        case "retrieve_memory": observation = JSON.stringify({ memories: this.memory }); break;
        case "save_memory": this.memory.push({ ...args, id: String(this.memory.length + 1) }); observation = "Saved in isolated scenario memory."; break;
        case "update_memory": case "delete_memory": fail("No matching memory in this scenario."); break;
        case "validate_screen": image = await this.screenshot(); observation = "Current screen attached for validation against the requested state."; break;
        default: throw new Error(`No simulator implementation for ${tool}; live fallback is forbidden`);
      }
    }
    const event = this.record({ kind: "tool", toolName: tool, args, text: JSON.stringify({ observation, toolSuccess }), durationMs: Date.now() - start });
    if (image) this.record({ kind: "image", text: `Screen after ${event.id}`, image });
    return { observation, toolSuccess, image };
  }
}
