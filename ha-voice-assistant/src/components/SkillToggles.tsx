import React from 'react';
import ToggleSwitch from './ToggleSwitch';
import { SkillToggleState } from '../utils/skillToggle';

interface SkillTogglesProps {
  skillState: SkillToggleState;
  onToggleGlobal: (enabled: boolean) => void;
  onToggleSkill: (skill: keyof Omit<SkillToggleState, 'globalEnabled'>, enabled: boolean) => void;
}

const SkillToggles: React.FC<SkillTogglesProps> = ({
  skillState,
  onToggleGlobal,
  onToggleSkill
}) => {
  return (
    <div style={{
      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
      borderRadius: '20px',
      padding: '1px',
      marginBottom: '30px',
      boxShadow: '0 10px 30px rgba(16, 185, 129, 0.3)',
      animation: 'fadeIn 0.6s ease-out'
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
        borderRadius: '19px',
        padding: '24px'
      }}>
        <div style={{ 
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '24px'
        }}>
          <h3 style={{ 
            margin: '0', 
            fontSize: '24px',
            fontWeight: '700',
            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}>
            <span style={{
              fontSize: '28px',
              filter: 'drop-shadow(0 2px 4px rgba(102, 126, 234, 0.3))'
            }}>
              ⚡
            </span>
            Smart Home Controls
          </h3>
          
          <div style={{
            padding: '8px 16px',
            backgroundColor: skillState.globalEnabled ? 'rgba(16, 185, 129, 0.1)' : 'rgba(148, 163, 184, 0.1)',
            borderRadius: '20px',
            fontSize: '12px',
            fontWeight: '600',
            color: skillState.globalEnabled ? '#059669' : '#64748b',
            border: `1px solid ${skillState.globalEnabled ? 'rgba(16, 185, 129, 0.2)' : 'rgba(148, 163, 184, 0.2)'}`,
            transition: 'all 0.3s ease'
          }}>
            {skillState.globalEnabled ? '🟢 ACTIVE' : '🔴 DISABLED'}
          </div>
        </div>
        
        <div style={{
          background: 'linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)',
          borderRadius: '16px',
          padding: '20px',
          marginBottom: '20px',
          border: '1px solid rgba(16, 185, 129, 0.1)'
        }}>
          <ToggleSwitch
            checked={skillState.globalEnabled}
            onChange={onToggleGlobal}
            label="Master Control"
            size="large"
          />
          <p style={{ 
            margin: '8px 0 0 0', 
            fontSize: '13px', 
            color: '#64748b',
            marginLeft: '72px',
            fontStyle: 'italic'
          }}>
            Toggle all smart home monitoring features at once
          </p>
        </div>

        <div style={{
          background: 'rgba(248, 250, 252, 0.5)',
          borderRadius: '16px',
          padding: '20px',
          border: '1px solid rgba(226, 232, 240, 0.5)'
        }}>
          <h4 style={{ 
            margin: '0 0 16px 0', 
            fontSize: '16px', 
            color: '#334155',
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <span style={{ fontSize: '16px' }}>🎛️</span>
            Individual Controls
          </h4>
          
          <div style={{ 
            display: 'grid',
            gap: '16px'
          }}>
            {[
              { key: 'laundryMonitor', label: 'Laundry Monitor', icon: '👕', desc: 'Track washing machine cycles' },
              { key: 'vacuumMonitor', label: 'Vacuum Monitor', icon: '🤖', desc: 'Monitor robot vacuum status' },
              { key: 'reminderManager', label: 'Voice Reminders', icon: '🎤', desc: 'AI-powered reminder system' }
            ].map((skill, index) => (
              <div key={skill.key} style={{
                background: 'white',
                borderRadius: '12px',
                padding: '16px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.05)',
                border: '1px solid rgba(226, 232, 240, 0.8)',
                transition: 'all 0.3s ease',
                animation: `slideIn 0.4s ease-out ${index * 0.1}s both`
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '20px' }}>{skill.icon}</span>
                    <div>
                      <div style={{ fontWeight: '600', color: '#1e293b', fontSize: '14px' }}>
                        {skill.label}
                      </div>
                      <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                        {skill.desc}
                      </div>
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={skillState[skill.key as keyof typeof skillState] as boolean}
                    onChange={(enabled) => onToggleSkill(skill.key as keyof Omit<SkillToggleState, 'globalEnabled'>, enabled)}
                    label=""
                    disabled={!skillState.globalEnabled}
                    size="medium"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SkillToggles;