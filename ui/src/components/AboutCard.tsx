import { Box, Link, Typography } from '@mui/material';
import type { MouseEvent } from 'react';
import { useCallback } from 'react';

interface AboutCardProps {
  onOpenUrl: (url: string) => Promise<void> | void;
}

export function AboutCard({ onOpenUrl }: AboutCardProps) {
  const handleOpen = useCallback(
    async (event: MouseEvent<HTMLAnchorElement>, url: string) => {
      event.preventDefault();
      await Promise.resolve(onOpenUrl(url));
    },
    [onOpenUrl],
  );

  return (
    <Box sx={{ p: 2, bgcolor: 'background.paper', borderRadius: 1 }}>
      <Typography variant="h6" gutterBottom>
        About Open WebUI Extension
      </Typography>
      <Typography variant="body2" color="text.secondary">
        The Open WebUI Extension makes it easy to run and manage Open WebUI within Docker. It
        provides a rich, user-friendly interface for interacting with LLMs—including OpenAI,
        Anthropic, and local models through Docker Model Runner or Ollama. With automatic
        configuration persistence and one-click startup, it&apos;s ideal for both quick testing and
        long-term use.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
        🚀 Brought to you by Docker Captain{' '}
        <Link href="#" onClick={(event) => handleOpen(event, 'https://github.com/rw4lll')}>
          Sergei Shitikov
        </Link>
        . Found a bug or have a cool idea? Drop it at{' '}
        <Link
          href="#"
          onClick={(event) =>
            handleOpen(event, 'https://github.com/rw4lll/open-webui-docker-extension/issues')
          }
        >
          GitHub Issues
        </Link>
        .
      </Typography>
    </Box>
  );
}
