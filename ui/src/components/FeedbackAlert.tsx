import type { AlertColor } from '@mui/material';
import { Alert } from '@mui/material';
import type { ReactNode } from 'react';

interface FeedbackAlertProps {
  severity: AlertColor;
  message: ReactNode;
  onClose?: () => void;
}

export function FeedbackAlert({ severity, message, onClose }: FeedbackAlertProps) {
  if (!message) {
    return null;
  }

  return (
    <Alert severity={severity} onClose={onClose}>
      {message}
    </Alert>
  );
}
