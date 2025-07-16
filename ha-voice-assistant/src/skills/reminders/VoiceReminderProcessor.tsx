import React, { useCallback } from 'react';
import { Reminder, ReminderCategory, ReminderPriority } from './types';
import { generateId } from './utils';

interface VoiceReminderProcessorProps {
  onReminderCreated: (reminder: Reminder) => void;
  onReminderAction: (action: 'list' | 'clear' | 'complete', data?: any) => void;
}

export interface VoiceReminderProcessorRef {
  processVoiceCommand: (command: string) => boolean;
}

const VoiceReminderProcessor: React.FC<VoiceReminderProcessorProps> = ({
  onReminderCreated,
  onReminderAction
}) => {
  
  const extractDateTime = (text: string): Date | null => {
    const now = new Date();
    
    // Time patterns
    const timePatterns = [
      /at (\d{1,2}):(\d{2})\s*(am|pm)?/i,
      /at (\d{1,2})\s*(am|pm)/i,
      /(\d{1,2}):(\d{2})\s*(am|pm)?/i,
      /(\d{1,2})\s*(am|pm)/i
    ];
    
    // Date patterns
    const datePatterns = [
      /tomorrow/i,
      /today/i,
      /in (\d+) minutes?/i,
      /in (\d+) hours?/i,
      /in (\d+) days?/i,
      /next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
      /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i
    ];
    
    let targetDate = new Date(now);
    let hasTime = false;
    
    // Extract time
    for (const pattern of timePatterns) {
      const match = text.match(pattern);
      if (match) {
        let hours = parseInt(match[1]);
        const minutes = match[2] ? parseInt(match[2]) : 0;
        const period = match[3] || match[4];
        
        if (period && period.toLowerCase() === 'pm' && hours !== 12) {
          hours += 12;
        } else if (period && period.toLowerCase() === 'am' && hours === 12) {
          hours = 0;
        }
        
        targetDate.setHours(hours, minutes, 0, 0);
        hasTime = true;
        break;
      }
    }
    
    // Extract date
    const lowerText = text.toLowerCase();
    for (const pattern of datePatterns) {
      const match = lowerText.match(pattern);
      if (match) {
        if (pattern.source.includes('tomorrow')) {
          targetDate.setDate(targetDate.getDate() + 1);
        } else if (pattern.source.includes('today')) {
          // Keep current date
        } else if (pattern.source.includes('in.*minutes')) {
          const minutes = parseInt(match[1]);
          targetDate = new Date(now.getTime() + minutes * 60 * 1000);
          return targetDate;
        } else if (pattern.source.includes('in.*hours')) {
          const hours = parseInt(match[1]);
          targetDate = new Date(now.getTime() + hours * 60 * 60 * 1000);
          return targetDate;
        } else if (pattern.source.includes('in.*days')) {
          const days = parseInt(match[1]);
          targetDate.setDate(targetDate.getDate() + days);
        } else if (pattern.source.includes('next.*day')) {
          const dayName = match[1].toLowerCase();
          const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
          const targetDay = days.indexOf(dayName);
          const currentDay = targetDate.getDay();
          const daysUntil = (targetDay - currentDay + 7) % 7 || 7;
          targetDate.setDate(targetDate.getDate() + daysUntil);
        } else if (pattern.source.includes('day.*day')) {
          const dayName = match[1].toLowerCase();
          const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
          const targetDay = days.indexOf(dayName);
          const currentDay = targetDate.getDay();
          let daysUntil = (targetDay - currentDay + 7) % 7;
          if (daysUntil === 0) daysUntil = 7; // Next week if same day
          targetDate.setDate(targetDate.getDate() + daysUntil);
        }
        break;
      }
    }
    
    // If no time specified, default to 9 AM
    if (!hasTime) {
      targetDate.setHours(9, 0, 0, 0);
    }
    
    // If the time is in the past today, move to tomorrow
    if (targetDate <= now) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    
    return targetDate;
  };
  
  const extractCategory = (text: string): ReminderCategory => {
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes('medication') || lowerText.includes('medicine') || lowerText.includes('pill')) {
      return 'medication';
    }
    if (lowerText.includes('meeting') || lowerText.includes('conference') || lowerText.includes('call')) {
      return 'meeting';
    }
    if (lowerText.includes('appointment') || lowerText.includes('doctor') || lowerText.includes('dentist')) {
      return 'appointment';
    }
    if (lowerText.includes('birthday') || lowerText.includes('anniversary')) {
      return 'birthday';
    }
    if (lowerText.includes('bill') || lowerText.includes('payment') || lowerText.includes('pay')) {
      return 'bill';
    }
    if (lowerText.includes('exercise') || lowerText.includes('workout') || lowerText.includes('gym')) {
      return 'exercise';
    }
    if (lowerText.includes('eat') || lowerText.includes('lunch') || lowerText.includes('dinner') || lowerText.includes('breakfast')) {
      return 'meal';
    }
    if (lowerText.includes('task') || lowerText.includes('todo') || lowerText.includes('work')) {
      return 'task';
    }
    
    return 'general';
  };
  
  const extractPriority = (text: string): ReminderPriority => {
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes('urgent') || lowerText.includes('emergency') || lowerText.includes('asap')) {
      return 'urgent';
    }
    if (lowerText.includes('important') || lowerText.includes('high priority')) {
      return 'high';
    }
    if (lowerText.includes('low priority') || lowerText.includes('when you can')) {
      return 'low';
    }
    
    return 'medium';
  };
  
  const cleanReminderText = (text: string): { title: string; description?: string } => {
    let cleanText = text
      .replace(/^(remind me to|set a reminder to|create a reminder to|add a reminder to)/i, '')
      .replace(/\s+(at \d{1,2}:?\d{0,2}\s*(am|pm)?)/i, '')
      .replace(/\s+(tomorrow|today|in \d+ (minutes?|hours?|days?))/i, '')
      .replace(/\s+(next (monday|tuesday|wednesday|thursday|friday|saturday|sunday))/i, '')
      .replace(/\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i, '')
      .replace(/\s+(urgent|important|high priority|low priority)/i, '')
      .trim();
    
    // Split on common separators for title/description
    const parts = cleanText.split(/\s+-\s+|\s+about\s+|\s+for\s+/);
    
    if (parts.length > 1) {
      return {
        title: parts[0].trim(),
        description: parts.slice(1).join(' - ').trim()
      };
    }
    
    return { title: cleanText };
  };
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const processVoiceCommand = useCallback((command: string): boolean => {
    const lowerCommand = command.toLowerCase().trim();
    
    // List reminders command
    if (lowerCommand.includes('list reminder') || 
        lowerCommand.includes('show reminder') || 
        lowerCommand.includes('what reminders') ||
        lowerCommand.includes('my reminders')) {
      onReminderAction('list');
      return true;
    }
    
    // Clear all reminders command
    if (lowerCommand.includes('clear all reminders') || 
        lowerCommand.includes('delete all reminders')) {
      onReminderAction('clear');
      return true;
    }
    
    // Create reminder command
    if (lowerCommand.includes('remind me') || 
        lowerCommand.includes('set a reminder') || 
        lowerCommand.includes('create a reminder') ||
        lowerCommand.includes('add a reminder')) {
      
      const dueDate = extractDateTime(command);
      if (!dueDate) {
        console.log('Could not extract valid date/time from command');
        return false;
      }
      
      const { title, description } = cleanReminderText(command);
      if (!title) {
        console.log('Could not extract reminder title from command');
        return false;
      }
      
      const category = extractCategory(command);
      const priority = extractPriority(command);
      const now = new Date();
      
      const reminder: Reminder = {
        id: generateId(),
        title,
        description,
        dueDate,
        category,
        priority,
        status: 'active',
        isRecurring: false,
        createdAt: now,
        updatedAt: now,
        notificationSent: false
      };
      
      onReminderCreated(reminder);
      return true;
    }
    
    return false;
  }, [onReminderCreated, onReminderAction]);
  
  return null; // This component doesn't render anything
};

export default VoiceReminderProcessor;