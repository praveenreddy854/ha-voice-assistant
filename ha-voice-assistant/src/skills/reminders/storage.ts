import { Reminder } from './types';

const API_BASE_URL = 'http://localhost:3005/api';

export const saveReminders = async (reminders: Reminder[]): Promise<void> => {
  try {
    const serializedReminders = reminders.map(reminder => ({
      ...reminder,
      dueDate: reminder.dueDate.toISOString(),
      createdAt: reminder.createdAt.toISOString(),
      updatedAt: reminder.updatedAt.toISOString(),
      completedAt: reminder.completedAt?.toISOString(),
      snoozeUntil: reminder.snoozeUntil?.toISOString(),
      recurringPattern: reminder.recurringPattern ? {
        ...reminder.recurringPattern,
        endDate: reminder.recurringPattern.endDate?.toISOString(),
      } : undefined,
    }));
    
    const response = await fetch(`${API_BASE_URL}/reminders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reminders: serializedReminders }),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to save reminders: ${response.statusText}`);
    }
  } catch (error) {
    console.error('Failed to save reminders:', error);
  }
};

export const loadReminders = async (): Promise<Reminder[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/reminders`);
    if (!response.ok) {
      throw new Error(`Failed to load reminders: ${response.statusText}`);
    }
    
    const stored = await response.json();
    if (!stored || !Array.isArray(stored)) return [];

    return stored.map((reminder: any) => ({
      ...reminder,
      dueDate: new Date(reminder.dueDate),
      createdAt: new Date(reminder.createdAt),
      updatedAt: new Date(reminder.updatedAt),
      completedAt: reminder.completedAt ? new Date(reminder.completedAt) : undefined,
      snoozeUntil: reminder.snoozeUntil ? new Date(reminder.snoozeUntil) : undefined,
      recurringPattern: reminder.recurringPattern ? {
        ...reminder.recurringPattern,
        endDate: reminder.recurringPattern.endDate ? new Date(reminder.recurringPattern.endDate) : undefined,
      } : undefined,
    }));
  } catch (error) {
    console.error('Failed to load reminders:', error);
    return [];
  }
};

export const saveProcessedReminders = async (processedIds: Set<string>): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/processed-reminders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ processedReminders: Array.from(processedIds) }),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to save processed reminders: ${response.statusText}`);
    }
  } catch (error) {
    console.error('Failed to save processed reminders:', error);
  }
};

export const loadProcessedReminders = async (): Promise<Set<string>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/processed-reminders`);
    if (!response.ok) {
      throw new Error(`Failed to load processed reminders: ${response.statusText}`);
    }
    
    const stored = await response.json();
    if (!stored || !Array.isArray(stored)) return new Set();
    
    return new Set(stored);
  } catch (error) {
    console.error('Failed to load processed reminders:', error);
    return new Set();
  }
};

export const clearReminders = async (): Promise<void> => {
  try {
    // Clear reminders by sending empty array
    await saveReminders([]);
    await saveProcessedReminders(new Set());
  } catch (error) {
    console.error('Failed to clear reminders:', error);
  }
};