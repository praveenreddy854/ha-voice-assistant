import React from 'react';

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: 'small' | 'medium' | 'large';
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ 
  checked, 
  onChange, 
  label, 
  disabled = false,
  size = 'medium'
}) => {
  const sizeStyles = {
    small: { width: '40px', height: '22px', thumbSize: '18px', fontSize: '12px' },
    medium: { width: '50px', height: '26px', thumbSize: '22px', fontSize: '14px' },
    large: { width: '60px', height: '32px', thumbSize: '28px', fontSize: '16px' }
  };

  const currentSize = sizeStyles[size];

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      onChange(!checked);
    }
  };

  const trackBackground = checked 
    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
    : 'linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)';

  const thumbShadow = checked
    ? '0 4px 12px rgba(16, 185, 129, 0.4), 0 2px 4px rgba(0,0,0,0.1)'
    : '0 2px 8px rgba(0,0,0,0.15)';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      userSelect: 'none',
      transition: 'opacity 0.2s ease'
    }} onClick={handleClick}>
      
      <div
        style={{
          width: currentSize.width,
          height: currentSize.height,
          background: disabled ? '#f1f5f9' : trackBackground,
          borderRadius: currentSize.height,
          position: 'relative',
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          pointerEvents: disabled ? 'none' : 'auto',
          border: checked ? '2px solid rgba(255,255,255,0.4)' : '2px solid rgba(0,0,0,0.08)',
          transform: disabled ? 'scale(0.95)' : 'scale(1)'
        }}
      >
        <div
          style={{
            width: currentSize.thumbSize,
            height: currentSize.thumbSize,
            background: disabled 
              ? '#94a3b8' 
              : checked 
                ? 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)'
                : 'linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%)',
            borderRadius: '50%',
            position: 'absolute',
            top: '2px',
            left: checked ? `calc(100% - ${currentSize.thumbSize} - 2px)` : '2px',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            boxShadow: thumbShadow,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {checked && (
            <div style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              animation: 'pulse 1.5s infinite'
            }} />
          )}
        </div>
        
        {/* Glow effect when enabled */}
        {checked && !disabled && (
          <div style={{
            position: 'absolute',
            top: '-2px',
            left: '-2px',
            right: '-2px',
            bottom: '-2px',
            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
            borderRadius: currentSize.height,
            opacity: 0.2,
            filter: 'blur(4px)',
            zIndex: -1
          }} />
        )}
      </div>
      
      <span style={{ 
        pointerEvents: 'none',
        fontSize: currentSize.fontSize,
        fontWeight: checked ? '600' : '500',
        color: disabled ? '#94a3b8' : checked ? '#1e293b' : '#64748b',
        transition: 'all 0.2s ease'
      }}>
        {label}
      </span>
    </div>
  );
};

export default ToggleSwitch;