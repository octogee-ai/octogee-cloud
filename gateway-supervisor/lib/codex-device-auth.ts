export interface CodexDeviceAuth {
  verificationUrl: string;
  userCode: string;
  expiresInMinutes: number | null;
}

export function parseCodexDeviceAuth(stdout: string): CodexDeviceAuth | null {
  if (!stdout) return null;

const clean = stdout
    // eslint-disable-next-line no-control-regex -- intentional ANSI CSI strip
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- intentional lone ESC strip
    .replace(/\x1b/g, "");

  const url = clean.match(/https?:\/\/[^\s]*device[^\s]*/i);
  const code = clean.match(/\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/);
  if (!url || !code) return null;

  const exp = clean.match(/expires in (\d+)\s*minutes?/i);
  return {
    verificationUrl: url[0],
    userCode: code[0],
    expiresInMinutes: exp ? Number(exp[1]) : null,
  };
}
