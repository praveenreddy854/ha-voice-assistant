export type ReminderPriority = 'low' | 'medium' | 'high' | 'urgent';

export type ReminderCategory = 
  | 'general' 
  | 'medication' 
  | 'meeting' 
  | 'task' 
  | 'appointment' 
  | 'birthday' 
  | 'bill' 
  | 'exercise' 
  | 'meal';

export type ReminderStatus = 'active' | 'completed' | 'dismissed' | 'snoozed';

export interface Reminder {
  id: string;
  title: string;
  description?: string;
  dueDate: Date;
  category: ReminderCategory;
  priority: ReminderPriority;
  status: ReminderStatus;
  isRecurring: boolean;
  recurringPattern?: {
    type: 'daily' | 'weekly' | 'monthly' | 'yearly';
    interval: number;
    endDate?: Date;
  };
  snoozeUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  notificationSent: boolean;
}

export interface ReminderNotification {
  reminder: Reminder;
  message: string;
  timestamp: Date;
}

export interface ReminderManagerProps {
  onAnnouncement?: (message: string) => void;
  voiceReminders?: Reminder[];
  onRemindersChange?: (reminders: Reminder[]) => void;
  onAddReminder?: (reminder: Reminder) => void;
}