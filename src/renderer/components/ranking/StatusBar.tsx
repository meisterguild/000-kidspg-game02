import React from 'react';

interface StatusBarProps {
  lastUpdated: Date;
  // Add other status props like error, loading, etc.
}

const StatusBar: React.FC<StatusBarProps> = ({ lastUpdated }) => {
  return (
    <div className="absolute top-4 right-4 text-sm text-gray-400">
      <p>Last Updated: {lastUpdated.toLocaleTimeString()}</p>
      {/* Add more status indicators here */}
    </div>
  );
};

export default StatusBar;
