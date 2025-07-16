import { Reminder, ReminderCategory, ReminderPriority } from './types';

export const generateId = (): string => {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
};

export const formatReminderTime = (date: Date): string => {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMs < 0) {
    return 'Overdue';
  }

  if (diffDays > 0) {
    return `in ${diffDays} day${diffDays > 1 ? 's' : ''}`;
  }

  if (diffHours > 0) {
    return `in ${diffHours} hour${diffHours > 1 ? 's' : ''}`;
  }

  if (diffMinutes > 0) {
    return `in ${diffMinutes} minute${diffMinutes > 1 ? 's' : ''}`;
  }

  return 'now';
};

export const isReminderDue = (reminder: Reminder): boolean => {
  const now = new Date();
  return reminder.dueDate <= now && reminder.status === 'active';
};

export const isReminderOverdue = (reminder: Reminder): boolean => {
  const now = new Date();
  const overdueThreshold = 5 * 60 * 1000; // 5 minutes
  return (now.getTime() - reminder.dueDate.getTime()) > overdueThreshold;
};

export const getPriorityColor = (priority: ReminderPriority): string => {
  switch (priority) {
    case 'urgent':
      return '#dc3545';
    case 'high':
      return '#fd7e14';
    case 'medium':
      return '#ffc107';
    case 'low':
      return '#28a745';
    default:
      return '#6c757d';
  }
};

export const getCategoryIcon = (category: ReminderCategory): string => {
  switch (category) {
    case 'medication':
      return '💊';
    case 'meeting':
      return '🏢';
    case 'task':
      return '✅';
    case 'appointment':
      return '📅';
    case 'birthday':
      return '🎂';
    case 'bill':
      return '💳';
    case 'exercise':
      return '🏃';
    case 'meal':
      return '🍽️';
    default:
      return '📝';
  }
};

export const createReminderAnnouncement = (reminder: Reminder): string => {
  const icon = getCategoryIcon(reminder.category);
  const urgencyText = reminder.priority === 'urgent' ? 'URGENT: ' : '';
  
  return `${urgencyText}${icon} Reminder: ${reminder.title}${
    reminder.description ? ` - ${reminder.description}` : ''
  }`;
};

export const calculateNextOccurrence = (reminder: Reminder): Date | null => {
  if (!reminder.isRecurring || !reminder.recurringPattern) {
    return null;
  }

  const { type, interval, endDate } = reminder.recurringPattern;
  const nextDate = new Date(reminder.dueDate);

  switch (type) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + interval);
      break;
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + (interval * 7));
      break;
    case 'monthly':
      nextDate.setMonth(nextDate.getMonth() + interval);
      break;
    case 'yearly':
      nextDate.setFullYear(nextDate.getFullYear() + interval);
      break;
  }

  if (endDate && nextDate > endDate) {
    return null;
  }

  return nextDate;
};

export const sortRemindersByPriority = (reminders: Reminder[]): Reminder[] => {
  const priorityOrder: Record<ReminderPriority, number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return [...reminders].sort((a, b) => {
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }
    return a.dueDate.getTime() - b.dueDate.getTime();
  });
};