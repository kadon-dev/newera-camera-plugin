import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NEWERA_CAMERA_PORT || 7889);
const NEWERA_URL = (process.env.NEWERA_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const NEWERA_TOKEN = process.env.NEWERA_TOKEN || "";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureServer() {
  const ping = await fetchJsonWithTimeout(`${BASE_URL}/api/ping`, {}, 1000);
  if (ping?.ok) {
    await fetchJsonWithTimeout(
      `${BASE_URL}/api/reconfigure`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ neweraUrl: NEWERA_URL, neweraToken: NEWERA_TOKEN }),
      },
      1000
    );
    return;
  }

  const logPath = join(tmpdir(), "newera-camera-control.log");
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [join(__dirname, "server.mjs")], {
      cwd: __dirname,
      env: {
        ...process.env,
        NEWERA_URL,
        NEWERA_TOKEN,
        NEWERA_CAMERA_PORT: String(PORT),
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ready = await fetchJsonWithTimeout(`${BASE_URL}/api/ping`, {}, 500);
    if (ready?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Camera Control server did not become ready on ${BASE_URL}`);
}

function openWindow() {
  const targetUrl = `${BASE_URL}/`;
  const launchDetached = (cmd, args) => {
    const proc = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    proc.unref();
  };

  if (process.platform === "darwin") {
    const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(macChrome)) {
      launchDetached(macChrome, [`--app=${targetUrl}`, "--window-size=500,860"]);
      return;
    }
    launchDetached("/usr/bin/open", [targetUrl]);
    return;
  }

  if (process.platform === "win32") {
    launchDetached("cmd", ["/c", "start", "", targetUrl]);
    return;
  }

  const linuxBrowsers = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const chrome = linuxBrowsers.find((bin) => existsSync(bin));
  if (chrome) {
    launchDetached(chrome, [`--app=${targetUrl}`, "--window-size=500,860"]);
    return;
  }
  launchDetached("xdg-open", [targetUrl]);
}

await ensureServer();
openWindow();
process.stdout.write(`Camera Control opened at ${BASE_URL}\n`);
process.exit(0);
