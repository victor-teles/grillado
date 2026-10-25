import { spawn } from "node:child_process";

/** Best-effort browser open. Never throws; the URL is always printed anyway (AC12). */
export function canOpenBrowser(env = process.env, platform = process.platform): boolean {
  if (env.CI) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

export function openBrowser(url: string, platform = process.platform): void {
  const [cmd, args] =
    platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore: the URL is printed
  }
}
