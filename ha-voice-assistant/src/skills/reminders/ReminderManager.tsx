import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Reminder, ReminderManagerProps } from './types';
import { 
  generateId, 
  isReminderDue, 
  createReminderAnnouncement, 
  calculateNextOccurrence,
  sortRemindersByPriority 
} from './utils';
import { saveReminders, loadReminders, saveProcessedReminders, loadProcessedReminders } from './storage';

const ReminderManager: React.FC<ReminderManagerProps> = ({ onAnnouncement, onRemindersChange, enabled = true }) => {
  const [reminders, setReminders] = useState<Reminder[]>([]);

  const checkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const processedRemindersRef = useRef<Set<string>>(new Set());

  const CHECK_INTERVAL_MS = 30000; // Check every 30 seconds

  const checkReminders = useCallback(() => {
    setReminders(currentReminders => {
      const now = new Date();
      let updatedReminders = [...currentReminders];
      let hasChanges = false;

      currentReminders.forEach(reminder => {
        if (reminder.status === 'active' && !reminder.notificationSent) {
          if (isReminderDue(reminder)) {
            if (!processedRemindersRef.current.has(reminder.id)) {
              const message = createReminderAnnouncement(reminder);
              console.log('Reminder due:', message);
              
              if (onAnnouncement) {
                onAnnouncement(message);
              }

              processedRemindersRef.current.add(reminder.id);
              saveProcessedReminders(processedRemindersRef.current).catch(console.error);
              
              const index = updatedReminders.findIndex(r => r.id === reminder.id);
              if (index !== -1) {
                updatedReminders[index] = {
                  ...reminder,
                  notificationSent: true,
                  updatedAt: now
                };
                hasChanges = true;

                if (reminder.isRecurring) {
                  const nextOccurrence = calculateNextOccurrence(reminder);
                  if (nextOccurrence) {
                    const newReminder: Reminder = {
                      ...reminder,
                      id: generateId(),
                      dueDate: nextOccurrence,
                      notificationSent: false,
                      createdAt: now,
                      updatedAt: now
                    };
                    updatedReminders.push(newReminder);
                    hasChanges = true;
                  }
                }
              }
            }
          }
        }
      });

      return hasChanges ? updatedReminders : currentReminders;
    });
  }, [onAnnouncement]);

  const startReminderChecking = useCallback(() => {
    if (!enabled) return;
    
    // Stop any existing interval first
    if (checkIntervalRef.current) {
      clearInterval(checkIntervalRef.current);
    }
    
    checkReminders();
    checkIntervalRef.current = setInterval(checkReminders, CHECK_INTERVAL_MS);
  }, [enabled, checkReminders]);

  const stopReminderChecking = useCallback(() => {
    if (checkIntervalRef.current) {
      clearInterval(checkIntervalRef.current);
      checkIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    const loadInitialData = async () => {
      try {
        const loaded = await loadReminders();
        setReminders(loaded);
        
        // Load processed reminders from API
        processedRemindersRef.current = await loadProcessedReminders();
        
        if (enabled) {
          startReminderChecking();
        }
      } catch (error) {
        console.error('Failed to load initial data:', error);
      }
    };
    
    loadInitialData();

    return () => {
      stopReminderChecking();
    };
  }, []);

  useEffect(() => {
    if (enabled) {
      startReminderChecking();
    } else {
      stopReminderChecking();
    }
  }, [enabled, startReminderChecking, stopReminderChecking]);

  useEffect(() => {
    const saveRemindersAsync = async () => {
      try {
        await saveReminders(reminders);
        // Notify parent component of reminder changes
        if (onRemindersChange) {
          onRemindersChange(reminders);
        }
      } catch (error) {
        console.error('Failed to save reminders:', error);
      }
    };
    
    saveRemindersAsync();
  }, [reminders, onRemindersChange]);

  // Expose addReminder function globally so it can be called from voice processing
  React.useEffect(() => {
    window.addReminderToManager = enabled ? addReminder : undefined;
  }, [enabled]);


  // Function to add reminders (for future voice integration)
  const addReminder = (reminder: Reminder) => {
    setReminders(prev => sortRemindersByPriority([...prev, reminder]));
  };


  const deleteReminder = (id: string) => {
    setReminders(prev => prev.filter(r => r.id !== id));
    processedRemindersRef.current.delete(id);
    saveProcessedReminders(processedRemindersRef.current).catch(console.error);
  };

  const completeReminder = (id: string) => {
    const now = new Date();
    setReminders(prev => 
      prev.map(r => 
        r.id === id 
          ? { ...r, status: 'completed' as const, completedAt: now, updatedAt: now }
          : r
      )
    );
  };

  const snoozeReminder = (id: string, minutes: number) => {
    const snoozeUntil = new Date(Date.now() + minutes * 60 * 1000);
    setReminders(prev => 
      prev.map(r => 
        r.id === id 
          ? { 
              ...r, 
              status: 'snoozed' as const, 
              snoozeUntil, 
              notificationSent: false,
              updatedAt: new Date() 
            }
          : r
      )
    );
    processedRemindersRef.current.delete(id);
    saveProcessedReminders(processedRemindersRef.current).catch(console.error);
  };


  return (
    <div style={{
      padding: '20px',
      border: '1px solid #ccc',
      borderRadius: '8px',
      margin: '10px 0',
      backgroundColor: '#f9f9f9'
    }}>
      <h3>Voice Reminders</h3>
      
      <div style={{ marginBottom: '15px', backgroundColor: '#e3f2fd', padding: '12px', borderRadius: '5px', border: '1px solid #2196f3' }}>
        <h4 style={{ margin: '0 0 8px 0', color: '#1976d2', fontSize: '14px' }}>🎤 Unified AI Voice Commands</h4>
        <div style={{ fontSize: '12px', color: '#1565c0', lineHeight: '1.4' }}>
          <p style={{ margin: '2px 0' }}><strong>"Remind me to..."</strong> - Create a new reminder</p>
          <p style={{ margin: '2px 0' }}><strong>"Show my reminders"</strong> - AI analyzes and suggests best display</p>
          <p style={{ margin: '2px 0' }}><strong>"What do I need to do?"</strong> - Smart priority with overdue detection</p>
          <p style={{ margin: '2px 0' }}><strong>"Any medicine reminders?"</strong> - Context-aware category queries</p>
          <p style={{ margin: '2px 0' }}><strong>"Top 3 reminders"</strong> - AI picks most urgent based on analysis</p>
          <p style={{ margin: '2px 0' }}>🤖 Single AI endpoint analyzes ALL your reminders for intelligent responses</p>
        </div>
      </div>

      <div>
        <h4>Active Reminders ({reminders.filter(r => r.status === 'active').length})</h4>
        {reminders.length === 0 ? (
          <p style={{ color: '#666', fontStyle: 'italic' }}>No reminders set</p>
        ) : (
          <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
            {reminders
              .filter(r => r.status === 'active')
              .map(reminder => (
                <div
                  key={reminder.id}
                  style={{
                    border: '1px solid #ddd',
                    borderRadius: '5px',
                    padding: '10px',
                    marginBottom: '10px',
                    backgroundColor: 'white',
                    borderLeft: `4px solid ${reminder.priority === 'urgent' ? '#dc3545' : 
                      reminder.priority === 'high' ? '#fd7e14' : 
                      reminder.priority === 'medium' ? '#ffc107' : '#28a745'}`
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <h5 style={{ margin: '0 0 5px 0', fontSize: '16px' }}>
                        {reminder.title}
                      </h5>
                      {reminder.description && (
                        <p style={{ margin: '0 0 5px 0', color: '#666', fontSize: '14px' }}>
                          {reminder.description}
                        </p>
                      )}
                      <div style={{ fontSize: '12px', color: '#888' }}>
                        <span>{reminder.dueDate.toLocaleString()}</span>
                        <span style={{ marginLeft: '10px' }}>
                          {reminder.category.charAt(0).toUpperCase() + reminder.category.slice(1)}
                        </span>
                        <span style={{ marginLeft: '10px', fontWeight: 'bold' }}>
                          {reminder.priority.toUpperCase()}
                        </span>
                        {reminder.isRecurring && (
                          <span style={{ marginLeft: '10px', color: '#007bff' }}>
                            🔄 Recurring
                          </span>
                        )}
                      </div>
                    </div>
                    
                    <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                      <button
                        onClick={() => completeReminder(reminder.id)}
                        style={{
                          backgroundColor: '#28a745',
                          color: 'white',
                          border: 'none',
                          padding: '5px 10px',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontSize: '12px'
                        }}
                      >
                        Complete
                      </button>
                      
                      <button
                        onClick={() => snoozeReminder(reminder.id, 15)}
                        style={{
                          backgroundColor: '#ffc107',
                          color: 'black',
                          border: 'none',
                          padding: '5px 10px',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontSize: '12px'
                        }}
                      >
                        Snooze 15m
                      </button>
                      
                      <button
                        onClick={() => deleteReminder(reminder.id)}
                        style={{
                          backgroundColor: '#dc3545',
                          color: 'white',
                          border: 'none',
                          padding: '5px 10px',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontSize: '12px'
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      <div style={{ fontSize: '12px', color: '#666', marginTop: '15px' }}>
        Checking for due reminders every 30 seconds
      </div>
    </div>
  );
};

export default ReminderManager;