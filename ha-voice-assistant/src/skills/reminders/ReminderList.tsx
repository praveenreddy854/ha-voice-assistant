import React from 'react';
import { Reminder } from './types';
import { 
  formatReminderTime, 
  getPriorityColor, 
  getCategoryIcon, 
  isReminderDue,
  isReminderOverdue 
} from './utils';

interface ReminderListProps {
  reminders: Reminder[];
  onComplete: (id: string) => void;
  onSnooze: (id: string, minutes: number) => void;
  onDelete: (id: string) => void;
  showCompleted?: boolean;
  maxHeight?: string;
}

const ReminderList: React.FC<ReminderListProps> = ({
  reminders,
  onComplete,
  onSnooze,
  onDelete,
  showCompleted = false,
  maxHeight = '300px'
}) => {
  const filteredReminders = showCompleted 
    ? reminders 
    : reminders.filter(r => r.status === 'active');

  const activeReminders = filteredReminders.filter(r => r.status === 'active');
  const completedReminders = filteredReminders.filter(r => r.status === 'completed');

  const renderReminder = (reminder: Reminder) => {
    const isDue = isReminderDue(reminder);
    const isOverdue = isReminderOverdue(reminder);
    const priorityColor = getPriorityColor(reminder.priority);
    const categoryIcon = getCategoryIcon(reminder.category);

    return (
      <div
        key={reminder.id}
        style={{
          border: '1px solid #ddd',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '8px',
          backgroundColor: reminder.status === 'completed' ? '#f8f9fa' : 'white',
          borderLeft: `4px solid ${priorityColor}`,
          opacity: reminder.status === 'completed' ? 0.7 : 1,
          boxShadow: isDue ? '0 2px 8px rgba(220, 53, 69, 0.3)' : '0 1px 3px rgba(0,0,0,0.1)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '18px' }}>{categoryIcon}</span>
              <h5 style={{ 
                margin: 0, 
                fontSize: '16px',
                textDecoration: reminder.status === 'completed' ? 'line-through' : 'none',
                color: reminder.status === 'completed' ? '#6c757d' : '#333'
              }}>
                {reminder.title}
              </h5>
              {isDue && reminder.status === 'active' && (
                <span style={{
                  backgroundColor: isOverdue ? '#dc3545' : '#ffc107',
                  color: isOverdue ? 'white' : '#333',
                  padding: '2px 6px',
                  borderRadius: '12px',
                  fontSize: '10px',
                  fontWeight: 'bold'
                }}>
                  {isOverdue ? 'OVERDUE' : 'DUE'}
                </span>
              )}
            </div>
            
            {reminder.description && (
              <p style={{ 
                margin: '0 0 8px 0', 
                color: '#666', 
                fontSize: '14px',
                textDecoration: reminder.status === 'completed' ? 'line-through' : 'none'
              }}>
                {reminder.description}
              </p>
            )}
            
            <div style={{ fontSize: '12px', color: '#888', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <span>
                📅 {reminder.dueDate.toLocaleDateString()} at {reminder.dueDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span>
                {formatReminderTime(reminder.dueDate)}
              </span>
              <span style={{ 
                backgroundColor: priorityColor,
                color: 'white',
                padding: '1px 4px',
                borderRadius: '3px',
                fontSize: '10px',
                fontWeight: 'bold'
              }}>
                {reminder.priority.toUpperCase()}
              </span>
              {reminder.isRecurring && (
                <span style={{ color: '#007bff' }}>
                  🔄 Recurring
                </span>
              )}
              {reminder.status === 'completed' && reminder.completedAt && (
                <span style={{ color: '#28a745' }}>
                  ✅ Completed {reminder.completedAt.toLocaleString()}
                </span>
              )}
            </div>
          </div>
          
          {reminder.status === 'active' && (
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0, flexDirection: 'column' }}>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  onClick={() => onComplete(reminder.id)}
                  style={{
                    backgroundColor: '#28a745',
                    color: 'white',
                    border: 'none',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    minWidth: '60px'
                  }}
                  title="Mark as completed"
                >
                  ✓ Done
                </button>
                
                <button
                  onClick={() => onDelete(reminder.id)}
                  style={{
                    backgroundColor: '#dc3545',
                    color: 'white',
                    border: 'none',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    minWidth: '50px'
                  }}
                  title="Delete reminder"
                >
                  🗑️
                </button>
              </div>
              
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  onClick={() => onSnooze(reminder.id, 15)}
                  style={{
                    backgroundColor: '#ffc107',
                    color: '#333',
                    border: 'none',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    minWidth: '50px'
                  }}
                  title="Snooze for 15 minutes"
                >
                  15m
                </button>
                
                <button
                  onClick={() => onSnooze(reminder.id, 60)}
                  style={{
                    backgroundColor: '#6f42c1',
                    color: 'white',
                    border: 'none',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    minWidth: '50px'
                  }}
                  title="Snooze for 1 hour"
                >
                  1h
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  if (filteredReminders.length === 0) {
    return (
      <div style={{
        padding: '20px',
        textAlign: 'center',
        color: '#666',
        fontStyle: 'italic',
        backgroundColor: '#f8f9fa',
        borderRadius: '8px',
        border: '1px solid #dee2e6'
      }}>
        {showCompleted ? 'No reminders found' : 'No active reminders'}
      </div>
    );
  }

  return (
    <div style={{ maxHeight, overflowY: 'auto' }}>
      {activeReminders.length > 0 && (
        <div style={{ marginBottom: showCompleted ? '20px' : '0' }}>
          {!showCompleted && (
            <h4 style={{ margin: '0 0 10px 0', color: '#333' }}>
              Active Reminders ({activeReminders.length})
            </h4>
          )}
          {activeReminders.map(renderReminder)}
        </div>
      )}
      
      {showCompleted && completedReminders.length > 0 && (
        <div>
          <h4 style={{ margin: '0 0 10px 0', color: '#666' }}>
            Completed Reminders ({completedReminders.length})
          </h4>
          {completedReminders.map(renderReminder)}
        </div>
      )}
    </div>
  );
};

export default ReminderList;