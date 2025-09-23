export const createDockerDesktopClient = () => ({
  docker: {
    cli: {
      exec: async (_cmd: string, _args?: string[]) => ({ stdout: '', stderr: '' }),
    },
  },
  host: {
    openExternal: async (_url: string) => {},
  },
});
