import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NEWERA_CAMERA_PORT || 7889);

let neweraUrl = (process.env.NEWERA_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
let neweraToken = process.env.NEWERA_TOKEN || "";
let mcpSessionId = null;
let rpcCounter = 1;
let failedHealthChecks = 0;

let mutationChain = Promise.resolve();
function runSerialized(fn) {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.catch(() => {});
  return next;
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (neweraToken) {
    headers.Authorization = `Bearer ${neweraToken}`;
  }
  return headers;
}

async function neweraFetch(path, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = authHeaders(options.headers || {});
    return await fetch(`${neweraUrl}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getHome() {
  const res = await neweraFetch("/api/home", {}, 10000);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Newera /api/home HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

async function applyCameras(mutatorFn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await getHome();
    const home = state.home || {};
    const currentCameras = structuredClone(home.cameras || {});
    const { cameras: nextCameras, result } = mutatorFn(currentCameras);

    const res = await neweraFetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [{ op: "set_cameras", cameras: nextCameras }],
        base_revision: state.revision,
      }),
    });

    if (res.status === 409 && attempt === 0) {
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Newera /api/commands HTTP ${res.status}: ${txt.slice(0, 250)}`);
    }
    await res.json().catch(() => null);
    return {
      cameras: formatCameras(nextCameras),
      result: result || {},
    };
  }
  throw new Error("Camera update conflicted twice with concurrent edits");
}

function formatCameras(cameras = {}) {
  const stored = Array.isArray(cameras.stored) ? cameras.stored : [];
  return {
    active: cameras.observer_active ? "visitor" : "aerial",
    observer: cameras.observer || null,
    rows: stored.map((c, i) => [
      i,
      c.name || `Point of view ${i + 1}`,
      Number(c.x) || 0,
      Number(c.y) || 0,
      Number(c.z) || 0,
      Number(c.yaw) || 0,
      Number(c.pitch) || 0,
      Number(c.fov) || 75,
    ]),
  };
}

function computeBuildingBounds(walls, rooms, furniture) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includePt = (pt) => {
    if (!Array.isArray(pt) || pt.length < 2) return;
    const x = Number(pt[0]);
    const y = Number(pt[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const w of walls) {
    includePt(w.start || w.a);
    includePt(w.end || w.b);
  }
  for (const r of rooms) {
    for (const pt of r.points || r.pts || []) {
      includePt(pt);
    }
  }

  if (!Number.isFinite(minX)) {
    for (const f of furniture) {
      if (Array.isArray(f.bounds) && f.bounds.length === 2) {
        includePt(f.bounds[0]);
        includePt(f.bounds[1]);
      }
    }
  }

  if (!Number.isFinite(minX)) {
    return [[0, 0], [750, 350]];
  }
  return [[minX, minY], [maxX, maxY]];
}

function buildStatePayload(state, requestedLevelId = null) {
  const home = state.home || {};
  const rawLevels = Array.isArray(home.levels) ? home.levels : [];
  const baseLevelId = rawLevels.length ? rawLevels[0].id : null;
  const levels = rawLevels.map((l) => ({
    id: l.id,
    name: l.name || l.id,
    elev: Number(l.elevation) || 0,
    h: Number(l.height) || 250,
    selected: l.id === home.selected_level,
  }));

  let planLevel = requestedLevelId || home.selected_level || baseLevelId;
  if (levels.length && !levels.some((l) => l.id === planLevel)) {
    planLevel = baseLevelId;
  }

  const belongsToLevel = (el) => {
    if (!levels.length || !planLevel) return true;
    const lv = el.level || baseLevelId;
    return lv === planLevel;
  };

  const allWalls = Array.isArray(home.walls) ? home.walls : [];
  const allRooms = Array.isArray(home.rooms) ? home.rooms : [];
  const allFurniture = Array.isArray(home.furniture) ? home.furniture : [];

  const walls = allWalls.filter(belongsToLevel).map((w) => ({
    id: w.id,
    a: w.start || w.a,
    b: w.end || w.b,
    t: Number(w.thickness) || 15,
  }));

  const rooms = allRooms.filter(belongsToLevel).map((r) => ({
    id: r.id,
    name: r.name || r.id,
    pts: r.points || r.pts || [],
  }));

  const openings = allFurniture
    .filter((f) => belongsToLevel(f) && /window|door|stairs|railing|column/i.test(`${f.catalog || ""} ${f.name || ""}`))
    .map((f) => ({
      id: f.id,
      name: f.name || "",
      cat: f.catalog || "",
      bounds: f.bounds,
    }));

  return {
    projectName: home.name || "Newera Project",
    revision: state.revision,
    bounds: computeBuildingBounds(allWalls, allRooms, allFurniture),
    levels,
    planLevel,
    plan: { walls, rooms, openings },
    cameras: formatCameras(home.cameras || {}),
  };
}

// Lightweight Streamable HTTP MCP client used only for optional render_3d / render_photo
async function rawMcpPost(payload, sessionId, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = authHeaders({
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    });
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    const res = await fetch(`${neweraUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const returnedSession = res.headers.get("mcp-session-id") || sessionId || null;
    if (payload.id === undefined) {
      try { await res.text(); } catch {}
      return { sessionId: returnedSession, message: null, status: res.status };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const err = new Error(`MCP HTTP ${res.status}: ${errText.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      return { sessionId: returnedSession, message: await res.json(), status: res.status };
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("Empty MCP response stream");
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines = [];

    const tryFlushEvent = () => {
      if (!dataLines.length) return null;
      const joined = dataLines.join("\n").trim();
      dataLines = [];
      if (!joined) return null;
      try {
        const parsed = JSON.parse(joined);
        if (parsed && parsed.id === payload.id) return parsed;
      } catch {}
      return null;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (rawLine === "") {
          const match = tryFlushEvent();
          if (match) {
            try { await reader.cancel(); } catch {}
            return { sessionId: returnedSession, message: match, status: res.status };
          }
        } else if (rawLine.startsWith("data:")) {
          dataLines.push(rawLine.slice(5).trimStart());
        }
      }
    }

    if (buffer.trim().startsWith("data:")) {
      dataLines.push(buffer.trim().slice(5).trimStart());
    }
    return { sessionId: returnedSession, message: tryFlushEvent(), status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureMcpSession() {
  if (mcpSessionId) return mcpSessionId;
  const initResp = await rawMcpPost(
    {
      jsonrpc: "2.0",
      id: rpcCounter++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "newera-camera-plugin", version: "1.0.0" },
      },
    },
    null
  );
  mcpSessionId = initResp.sessionId || null;
  if (mcpSessionId) {
    await rawMcpPost(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      mcpSessionId
    ).catch(() => {});
  }
  return mcpSessionId;
}

async function callMcpTool(name, args = {}, retry = true) {
  try {
    const sid = await ensureMcpSession();
    const { message } = await rawMcpPost(
      {
        jsonrpc: "2.0",
        id: rpcCounter++,
        method: "tools/call",
        params: { name, arguments: args },
      },
      sid
    );
    if (!message) throw new Error(`No JSON-RPC reply from ${name}`);
    if (message.error) throw new Error(message.error.message || JSON.stringify(message.error));
    const result = message.result || {};
    if (result.isError) {
      const txt = (result.content || []).map((c) => c.text || "").join("\n");
      throw new Error(txt || `Tool ${name} returned an error`);
    }
    return result.content || [];
  } catch (err) {
    if (retry && (err.status === 400 || err.status === 404 || /session/i.test(err.message))) {
      mcpSessionId = null;
      return callMcpTool(name, args, false);
    }
    throw err;
  }
}

function extractImageDataUrl(content) {
  const img = content.find((c) => c.type === "image" && c.data);
  if (!img) return null;
  return `data:${img.mimeType || "image/png"};base64,${img.data}`;
}

function parseCamPose(body) {
  const x = Number(body.x);
  const y = Number(body.y);
  const z = Number(body.z);
  const yaw = Number(body.yaw);
  const pitch = Number(body.pitch);
  const fov = Number(body.fov);
  if ([x, y, z, yaw, pitch, fov].some((n) => !Number.isFinite(n))) {
    throw new Error("Invalid numeric camera pose");
  }
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    z: Math.round(z * 10) / 10,
    yaw: Math.round(yaw * 10) / 10,
    pitch: Math.round(pitch * 10) / 10,
    fov: Math.max(25, Math.min(120, Math.round(fov))),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf-8");
      if (raw.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = readFileSync(join(__dirname, "index.html"), "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && pathname === "/api/ping") {
      sendJson(res, 200, { ok: true, neweraUrl, pid: process.pid });
      return;
    }

    if (req.method === "POST" && pathname === "/api/reconfigure") {
      const body = await readJsonBody(req);
      if (typeof body.neweraUrl === "string" && body.neweraUrl.trim()) {
        neweraUrl = body.neweraUrl.trim().replace(/\/+$/, "");
        mcpSessionId = null;
      }
      if (typeof body.neweraToken === "string") {
        neweraToken = body.neweraToken;
        mcpSessionId = null;
      }
      failedHealthChecks = 0;
      sendJson(res, 200, { ok: true, neweraUrl });
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const levelId = url.searchParams.get("level") || null;
      const homeData = await getHome();
      sendJson(res, 200, { ok: true, ...buildStatePayload(homeData, levelId) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/events") {
      const upstreamAbort = new AbortController();
      req.on("close", () => upstreamAbort.abort());

      const eventsPath = neweraToken
        ? `/api/events?token=${encodeURIComponent(neweraToken)}`
        : "/api/events";

      let upstreamRes;
      try {
        upstreamRes = await fetch(`${neweraUrl}${eventsPath}`, {
          headers: authHeaders({ Accept: "text/event-stream" }),
          signal: upstreamAbort.signal,
        });
      } catch {
        res.writeHead(502);
        res.end();
        return;
      }

      if (!upstreamRes.ok || !upstreamRes.body) {
        res.writeHead(upstreamRes.status || 502);
        res.end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!res.writableEnded) res.write(value);
        }
      } catch {
        // Client or upstream disconnected
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/camera/live") {
      const pose = parseCamPose(await readJsonBody(req));
      const outcome = await runSerialized(() =>
        applyCameras((cameras) => {
          const prevObserver = cameras.observer || {};
          cameras.observer = {
            ...prevObserver,
            ...pose,
            time: prevObserver.time ?? 0,
          };
          cameras.observer_active = true;
          return { cameras };
        })
      );
      sendJson(res, 200, { ok: true, cameras: outcome.cameras });
      return;
    }

    if (req.method === "POST" && pathname === "/api/camera/select") {
      const body = await readJsonBody(req);
      const outcome = await runSerialized(() =>
        applyCameras((cameras) => {
          if (body.mode === "aerial") {
            cameras.observer_active = false;
            return { cameras };
          }
          const idx = Number(body.i);
          const stored = Array.isArray(cameras.stored) ? cameras.stored : [];
          if (!Number.isInteger(idx) || idx < 0 || idx >= stored.length) {
            throw new Error(`Invalid camera index ${body.i}`);
          }
          cameras.observer = structuredClone(stored[idx]);
          cameras.observer_active = true;
          return { cameras };
        })
      );
      sendJson(res, 200, { ok: true, cameras: outcome.cameras });
      return;
    }

    if (req.method === "POST" && pathname === "/api/camera/save") {
      const body = await readJsonBody(req);
      const pose = parseCamPose(body);
      const name = String(body.name || "Saved Camera").trim() || "Saved Camera";
      const overwriteIndex =
        body.overwriteIndex !== undefined && body.overwriteIndex !== null
          ? Number(body.overwriteIndex)
          : null;

      const outcome = await runSerialized(() =>
        applyCameras((cameras) => {
          const stored = Array.isArray(cameras.stored) ? cameras.stored : [];
          const camObj = {
            ...pose,
            name,
            time: 0,
          };
          let savedIndex;
          if (
            overwriteIndex !== null &&
            Number.isInteger(overwriteIndex) &&
            overwriteIndex >= 0 &&
            overwriteIndex < stored.length
          ) {
            camObj.time = stored[overwriteIndex]?.time ?? 0;
            stored[overwriteIndex] = camObj;
            savedIndex = overwriteIndex;
          } else {
            stored.push(camObj);
            savedIndex = stored.length - 1;
          }
          cameras.stored = stored;
          cameras.observer = structuredClone(camObj);
          cameras.observer_active = true;
          return { cameras, result: { savedIndex } };
        })
      );
      sendJson(res, 200, {
        ok: true,
        cameras: outcome.cameras,
        savedIndex: outcome.result.savedIndex,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/camera/delete") {
      const body = await readJsonBody(req);
      const idx = Number(body.i);
      const outcome = await runSerialized(() =>
        applyCameras((cameras) => {
          const stored = Array.isArray(cameras.stored) ? cameras.stored : [];
          if (!Number.isInteger(idx) || idx < 0 || idx >= stored.length) {
            throw new Error(`Invalid camera index ${body.i}`);
          }
          stored.splice(idx, 1);
          cameras.stored = stored;
          return { cameras };
        })
      );
      sendJson(res, 200, { ok: true, cameras: outcome.cameras });
      return;
    }

    if (req.method === "POST" && pathname === "/api/camera/preview") {
      const state = await getHome();
      const isAerial = !state.home?.cameras?.observer_active;
      const content = await callMcpTool("render_3d", {
        view: isAerial ? "aerial" : "visitor",
        level: "all",
        w: 480,
        h: 300,
      });
      sendJson(res, 200, { ok: true, image: extractImageDataUrl(content) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/camera/photo") {
      const body = await readJsonBody(req);
      const quality = ["draft", "good", "best"].includes(body.quality) ? body.quality : "draft";
      const hour = body.hour !== undefined ? Number(body.hour) : 10.5;
      const state = await getHome();
      const levels = state.home?.levels || [];
      if (levels.length > 0) {
        const topId = levels[levels.length - 1].id;
        if (state.home?.selected_level !== topId) {
          await callMcpTool("edit_levels", { action: "select", id: topId }).catch(() => {});
        }
      }
      const content = await callMcpTool("render_photo", {
        view: "visitor",
        quality,
        hour,
        w: 640,
        h: 400,
      });
      sendJson(res, 200, { ok: true, image: extractImageDataUrl(content) });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || String(err) });
  }
});

// Auto-shutdown 30s (3 failed 10s checks) after Newera closes
const healthWatcher = setInterval(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${neweraUrl}/health`, { signal: controller.signal });
    if (res.ok) {
      failedHealthChecks = 0;
    } else {
      failedHealthChecks++;
    }
  } catch {
    failedHealthChecks++;
  } finally {
    clearTimeout(timer);
  }
  if (failedHealthChecks >= 3) {
    clearInterval(healthWatcher);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }
}, 10000);
healthWatcher.unref();

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    clearInterval(healthWatcher);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  console.error(`Newera Camera Control plugin server listening on http://127.0.0.1:${actualPort} -> ${neweraUrl}`);
});
