export interface SkillToggleState {
  globalEnabled: boolean;
  laundryMonitor: boolean;
  vacuumMonitor: boolean;
}

const DEFAULT_SKILL_STATE: SkillToggleState = {
  globalEnabled: true,
  laundryMonitor: true,
  vacuumMonitor: true,
};

const STORAGE_KEY = 'ha-voice-assistant-skill-toggles';

export const loadSkillToggleState = (): SkillToggleState => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge with defaults to handle any missing properties
      return { ...DEFAULT_SKILL_STATE, ...parsed };
    }
  } catch (error) {
    console.error('Error loading skill toggle state:', error);
  }
  return DEFAULT_SKILL_STATE;
};

export const saveSkillToggleState = (state: SkillToggleState): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Error saving skill toggle state:', error);
  }
};

export const isSkillEnabled = (
  skillName: keyof Omit<SkillToggleState, 'globalEnabled'>,
  state: SkillToggleState
): boolean => {
  return state.globalEnabled && state[skillName];
};