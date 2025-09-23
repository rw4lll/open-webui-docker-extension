import { Alert, Box, Button, Typography } from '@mui/material';
import React from 'react';

import { log } from './logger';

interface ErrorBoundaryState {
  hasError: boolean;
  error: string;
  stack?: string;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: '', stack: undefined };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    log.error('Error caught by boundary:', error, errorInfo);
    if (import.meta.env.DEV && errorInfo?.componentStack) {
      this.setState({ stack: errorInfo.componentStack });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box sx={{ p: 3 }}>
          <Alert severity="error">
            <Typography variant="h6" gutterBottom>
              Something went wrong
            </Typography>
            <Typography variant="body2">{this.state.error}</Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              Please refresh the page or check the Docker Desktop logs for more information.
            </Typography>
            <Button
              variant="outlined"
              color="inherit"
              size="small"
              sx={{ mt: 2 }}
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
            {import.meta.env.DEV && this.state.stack ? (
              <Typography component="pre" variant="caption" sx={{ mt: 2, whiteSpace: 'pre-wrap' }}>
                {this.state.stack}
              </Typography>
            ) : null}
          </Alert>
        </Box>
      );
    }

    return this.props.children;
  }
}
