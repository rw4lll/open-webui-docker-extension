import { Settings, Save, Refresh, Warning, CheckCircle } from '@mui/icons-material';
import {
  Card,
  CardContent,
  CardActions,
  Typography,
  Stack,
  TextField,
  Button,
  CircularProgress,
  InputAdornment,
  Alert,
  Box,
  Chip,
  Divider,
  FormControlLabel,
  Switch,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useCallback, useEffect, useState } from 'react';

import { log } from '../logger';
import type { ExtensionConfig } from '../types';

interface ConfigCardProps {
  config: ExtensionConfig;
  loading: boolean;
  onUpdate: (config: ExtensionConfig) => Promise<void>;
  validateConfig?: (config: ExtensionConfig) => string[];
}

export default function ConfigCard({ config, loading, onUpdate, validateConfig }: ConfigCardProps) {
  const [localConfig, setLocalConfig] = useState<ExtensionConfig>(config);
  const [hasChanges, setHasChanges] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Sync local config with prop changes
  useEffect(() => {
    setLocalConfig(config);
    setHasChanges(false);
  }, [config]);

  const runValidation = useCallback(
    (cfg: ExtensionConfig): string[] => (validateConfig ? validateConfig(cfg) : []),
    [validateConfig],
  );

  // Handle local config changes
  const handleLocalConfigChange = (newConfig: ExtensionConfig) => {
    setLocalConfig(newConfig);
    setHasChanges(
      newConfig.image !== config.image ||
        newConfig.port !== config.port ||
        newConfig.autoStart !== config.autoStart,
    );
    setValidationErrors(runValidation(newConfig));
  };

  // Handle update
  const handleUpdate = async () => {
    const errors = runValidation(localConfig);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }

    try {
      await onUpdate(localConfig);
      setHasChanges(false);
      setValidationErrors([]);
    } catch (error) {
      // Error handling is done in parent component
      log.error('Config update failed:', error);
    }
  };

  // Handle reset
  const handleReset = () => {
    setLocalConfig(config);
    setHasChanges(false);
    setValidationErrors([]);
  };

  const isValid = validationErrors.length === 0;

  return (
    <Card
      sx={(theme) => ({
        minHeight: '100%',
        borderRadius: 2,
        border: '1px solid',
        borderColor:
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.common.white, 0.12)
            : alpha(theme.palette.common.black, 0.1),
        backgroundColor:
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.background.default, 0.92)
            : alpha(theme.palette.background.paper, 0.98),
        backdropFilter: 'blur(8px)',
      })}
    >
      <CardContent>
        <Typography
          variant="h6"
          gutterBottom
          sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
        >
          <Settings />
          Configuration
        </Typography>

        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography variant="body2">
            <strong>Important:</strong> Changing settings will recreate the container with new
            configuration. Your data will be preserved in Docker volumes.
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            First run may take longer because the Docker image is pulled locally.
          </Typography>
        </Alert>

        {hasChanges && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <Typography variant="body2">
              <strong>Unsaved Changes:</strong> You have unsaved configuration changes.
            </Typography>
          </Alert>
        )}

        {validationErrors.length > 0 && (
          <Alert severity="error" sx={{ mb: 2 }}>
            <Typography variant="body2" component="div">
              <strong>Validation Errors:</strong>
              <ul style={{ margin: '4px 0', paddingLeft: '20px' }}>
                {validationErrors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </Typography>
          </Alert>
        )}

        <Stack spacing={3}>
          <Box>
            <TextField
              label="Docker Image"
              value={localConfig.image}
              onChange={(e) => handleLocalConfigChange({ ...localConfig, image: e.target.value })}
              fullWidth
              size="small"
              error={validationErrors.some((e) => e.includes('image'))}
              helperText="Open WebUI Docker image (tag is added if missing, e.g., :main)"
              InputProps={{
                startAdornment: <InputAdornment position="start">Image</InputAdornment>,
              }}
            />
            {localConfig.image !== config.image && (
              <Chip
                label="Changed"
                color="warning"
                size="small"
                sx={{ mt: 1 }}
                icon={<Warning />}
              />
            )}
          </Box>

          <Box>
            <TextField
              label="Host Port"
              value={localConfig.port}
              onChange={(e) => handleLocalConfigChange({ ...localConfig, port: e.target.value })}
              fullWidth
              size="small"
              type="number"
              error={validationErrors.some((e) => e.includes('Port'))}
              helperText="Port to expose Open WebUI on localhost (e.g., 8090)"
              InputProps={{
                startAdornment: <InputAdornment position="start">Port</InputAdornment>,
              }}
            />
            {localConfig.port !== config.port && (
              <Chip
                label="Will recreate container"
                color="warning"
                size="small"
                sx={{ mt: 1 }}
                icon={<Refresh />}
              />
            )}
          </Box>

          <Box>
            <FormControlLabel
              control={
                <Switch
                  checked={!!localConfig.autoStart}
                  onChange={(e) =>
                    handleLocalConfigChange({ ...localConfig, autoStart: e.target.checked })
                  }
                  size="small"
                />
              }
              label="Auto-create and auto-start container"
            />
            {localConfig.autoStart !== config.autoStart && (
              <Chip
                label="Changed"
                color="warning"
                size="small"
                sx={{ ml: 1 }}
                icon={<Warning />}
              />
            )}
          </Box>

          {/* Token field removed: token is managed automatically under the hood */}
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Current: {config.image} on port {config.port}
          </Typography>
          {!hasChanges && (
            <Chip label="Saved" color="success" size="small" icon={<CheckCircle />} />
          )}
        </Box>
      </CardContent>

      <CardActions sx={{ justifyContent: 'space-between', px: 2, pb: 2 }}>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="contained"
            color="primary"
            startIcon={loading ? <CircularProgress size={16} /> : <Save />}
            onClick={handleUpdate}
            disabled={loading || !hasChanges || !isValid}
            sx={{ minWidth: 160 }}
          >
            {loading ? 'Updating...' : 'Apply Changes'}
          </Button>

          <Button
            variant="text"
            color="inherit"
            onClick={handleReset}
            disabled={loading || !hasChanges}
          >
            Reset
          </Button>
        </Box>

        <Typography variant="caption" color="text.secondary">
          {hasChanges ? 'Changes pending' : 'No changes'}
        </Typography>
      </CardActions>
    </Card>
  );
}
