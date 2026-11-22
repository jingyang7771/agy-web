const http = require("http");
const https = require("https");
const tls = require("tls");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const { StringDecoder } = require("string_decoder");

const PORT = parseInt(process.env.PORT || "3456", 10);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const ALIASES_FILE = path.join(DATA_DIR, "session-aliases.json");
const HIDDEN_FILE = path.join(DATA_DIR, "hidden-sessions.json");
const SNIPPETS_FILE = path.join(DATA_DIR, "snippets.json");
const TRANSLATE_CACHE_FILE = path.join(DATA_DIR, "thought-translations.json");
const PREFS_FILE = path.join(DATA_DIR, "preferences.json");

function loadPreferences() {
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
      if (parsed && typeof parsed === "object") {
        const dm = typeof parsed.defaultMode === "string" ? parsed.defaultMode.trim() : "";
        return {
          sandbox: !!parsed.sandbox,
          defaultMode: dm || "auto",
        };
      }
    }
  } catch (_) {}
  return { sandbox: false, defaultMode: "auto" };
}

function savePreferences(prefs) {
  try {
    const clean = {
      sandbox: !!prefs.sandbox,
      defaultMode: typeof prefs.defaultMode === "string" ? prefs.defaultMode.trim() : "",
    };
    fs.writeFileSync(PREFS_FILE, JSON.stringify(clean, null, 2), "utf8");
  } catch (e) {
    console.error("[prefs] save error:", e.message);
  }
}

let translateCache = {};
try {
  if (fs.existsSync(TRANSLATE_CACHE_FILE)) {
    translateCache = JSON.parse(fs.readFileSync(TRANSLATE_CACHE_FILE, "utf8")) || {};
  }
} catch (_) {
  translateCache = {};
}

function saveTranslateCache() {
  try {
    const keys = Object.keys(translateCache);
    if (keys.length > 2000) {
      for (const k of keys.slice(0, keys.length - 1500)) delete translateCache[k];
    }
    fs.writeFileSync(TRANSLATE_CACHE_FILE, JSON.stringify(translateCache, null, 2), "utf8");
  } catch (_) {}
}

let detectedProxyCache = { ts: 0, proxyUrl: null };
function detectSystemProxy() {
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (envProxy) return envProxy.trim();
  if (process.platform !== "win32") return null;

  const now = Date.now();
  if (now - detectedProxyCache.ts < 30000) return detectedProxyCache.proxyUrl;
  let proxyUrl = null;
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { encoding: "utf8", timeout: 2000 }
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
    if (enabled) {
      const m = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
      if (m) {
        let srv = m[1].trim();
        // Handle per-protocol format like "http=127.0.0.1:7890;https=127.0.0.1:7890"
        if (srv.includes("=")) {
          const hm = srv.match(/https=([^;]+)/i) || srv.match(/http=([^;]+)/i);
          srv = hm ? hm[1].trim() : "";
        }
        if (srv) {
          proxyUrl = /^https?:\/\//i.test(srv) ? srv : `http://${srv}`;
        }
      }
    }
  } catch (_) {}
  detectedProxyCache = { ts: now, proxyUrl };
  return proxyUrl;
}

function httpsGetText(targetUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const proxyStr = detectSystemProxy();
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => done(new Error("翻译请求超时")), timeoutMs);

    const doHttpsRequest = (socket) => {
      const opts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Accept: "application/json,text/plain,*/*",
        },
      };
      if (socket) {
        opts.createConnection = () =>
          tls.connect({ socket, servername: u.hostname });
      }
      const req = https.request(opts, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            done(null, body);
          } else {
            done(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
          }
        });
      });
      req.on("error", (e) => done(e));
      req.end();
    };

    if (proxyStr && /^https?:\/\//i.test(proxyStr)) {
      try {
        const pu = new URL(proxyStr);
        const connectReq = http.request({
          host: pu.hostname,
          port: parseInt(pu.port || "80", 10),
          method: "CONNECT",
          path: `${u.hostname}:${u.port || 443}`,
        });
        connectReq.on("connect", (res, socket) => {
          if (res.statusCode === 200) {
            doHttpsRequest(socket);
          } else {
            socket.destroy();
            doHttpsRequest(null); // Fallback direct
          }
        });
        connectReq.on("error", () => doHttpsRequest(null));
        connectReq.end();
        return;
      } catch (_) {}
    }
    doHttpsRequest(null);
  });
}

async function translateChunkFree(chunk) {
  // Primary: Google Translate lightweight public endpoint (0 LLM tokens)
  try {
    const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(chunk)}`;
    const body = await httpsGetText(gUrl, 10000);
    const data = JSON.parse(body);
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const joined = data[0].map((seg) => (Array.isArray(seg) ? seg[0] : "")).join("");
      if (joined.trim()) return joined.trim();
    }
  } catch (e) {
    // Fallback: MyMemory free endpoint (split into <=450 char slices so nothing is ever truncated)
    try {
      const slices = splitTextByLimit(chunk, 450);
      const out = [];
      for (const sl of slices) {
        const mUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(sl)}&langpair=en|zh-CN`;
        const body = await httpsGetText(mUrl, 10000);
        const data = JSON.parse(body);
        const t = data?.responseData?.translatedText;
        if (t && t.trim()) out.push(t.trim());
        else out.push(sl);
      }
      if (out.length) return out.join("\n");
    } catch (_) {}
    throw e;
  }
  throw new Error("翻译接口返回空结果");
}

function splitTextByLimit(text, limit = 850) {
  const s = String(text || "").trim();
  if (!s) return [];
  if (s.length <= limit) return [s];
  const pieces = [];
  const lines = s.split("\n");
  let cur = "";
  const flush = () => {
    if (cur.trim()) pieces.push(cur.trim());
    cur = "";
  };
  for (const line of lines) {
    if (line.length > limit) {
      flush();
      // Split very long single line by sentence boundaries or hard limit
      let rest = line;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(". ", limit);
        if (cut < limit * 0.4) cut = rest.lastIndexOf(" ", limit);
        if (cut < limit * 0.4) cut = limit;
        else cut += 1;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) cur = rest;
    } else if (cur && cur.length + line.length + 1 > limit) {
      flush();
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  flush();
  return pieces;
}

async function translateThoughtToZh(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return { translated: "", cached: true };
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
  if (translateCache[hash]) {
    return { translated: translateCache[hash], cached: true };
  }

  // Split long text safely into <=850 char batches (handling single giant paragraphs too)
  const paras = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const batches = [];
  let cur = "";
  for (const p of paras) {
    const part = p.trim();
    if (!part) continue;
    if (part.length > 850) {
      if (cur) {
        batches.push(cur);
        cur = "";
      }
      for (const sub of splitTextByLimit(part, 850)) batches.push(sub);
    } else if (cur && cur.length + part.length + 2 > 850) {
      batches.push(cur);
      cur = part;
    } else {
      cur = cur ? `${cur}\n\n${part}` : part;
    }
  }
  if (cur) batches.push(cur);

  const outParts = [];
  for (const b of batches) {
    const tr = await translateChunkFree(b);
    outParts.push(tr);
  }
  const translated = outParts.join("\n\n");
  translateCache[hash] = translated;
  saveTranslateCache();
  return { translated, cached: false };
}

const DEFAULT_SNIPPETS = [
  { id: "snip-review", title: "代码审查", text: "请仔细审查当前修改的代码，指出潜在 Bug、边界情况和性能问题，并给出具体修复建议。" },
  { id: "snip-test", title: "补充单元测试", text: "请为刚才修改的核心逻辑补充全面且可运行的单元测试，覆盖正常路径和异常边界，并运行测试确认通过。" },
  { id: "snip-explain", title: "逐行解释原理", text: "请用通俗易懂的中文分步骤解释这段代码的核心逻辑、数据流以及关键设计取舍。" },
  { id: "snip-fix", title: "排查报错根因", text: "请帮我定位这个报错的根本原因，给出最小化、最稳妥的修复方案并验证结果：" },
  { id: "snip-summary", title: "总结改动并更新文档", text: "请总结本次会话所做的全部文件改动、验证结果，并同步更新项目 README 文档。" },
];

function loadSnippets() {
  try {
    if (fs.existsSync(SNIPPETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SNIPPETS_FILE, "utf8"));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {}
  return DEFAULT_SNIPPETS.slice();
}

function saveSnippets(list) {
  if (!Array.isArray(list)) throw new Error("模板列表格式无效");
  const clean = list
    .filter((s) => s && typeof s.title === "string" && typeof s.text === "string" && s.title.trim() && s.text.trim())
    .slice(0, 100)
    .map((s) => ({
      id: String(s.id || "snip-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6)),
      title: s.title.trim().slice(0, 60),
      text: s.text.trim().slice(0, 4000),
    }));
  fs.writeFileSync(SNIPPETS_FILE, JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function isValidSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

function loadHiddenSessions() {
  try {
    if (fs.existsSync(HIDDEN_FILE)) {
      const arr = JSON.parse(fs.readFileSync(HIDDEN_FILE, "utf8"));
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (_) {}
  return new Set();
}

function saveHiddenSessions(setObj) {
  try {
    fs.writeFileSync(HIDDEN_FILE, JSON.stringify(Array.from(setObj), null, 2), "utf8");
  } catch (e) {
    console.error("[hidden] save error:", e.message);
  }
}

function normalizeCwd(p) {
  if (!p) return process.cwd();
  let s = String(p).trim();
  // Convert "/C:/Users/..." -> "C:\Users\..." on Windows
  if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(s)) {
    s = s.slice(1).replace(/\//g, "\\");
  }
  return s;
}

function loadAliases() {
  try {
    if (fs.existsSync(ALIASES_FILE)) {
      return JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8"));
    }
  } catch (_) {}
  return {};
}

function saveAliases(aliases) {
  try {
    fs.writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2), "utf8");
  } catch (e) {
    console.error("[aliases] save error:", e.message);
  }
}

// Parse local transcript.jsonl as fallback / enrichment for loaded sessions
function readLocalTranscript(sessionId) {
  try {
    const baseDir = path.join(
      os.homedir(),
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs"
    );
    const fullPath = path.join(baseDir, "transcript_full.jsonl");
    const compactPath = path.join(baseDir, "transcript.jsonl");
    const targetPath = fs.existsSync(fullPath)
      ? fullPath
      : fs.existsSync(compactPath)
        ? compactPath
        : null;
    if (!targetPath) return null;

    const raw = fs.readFileSync(targetPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const items = [];
    const pendingTools = [];

    for (const line of lines) {
      let step;
      try {
        step = JSON.parse(line);
      } catch (_) {
        continue;
      }

      if (step.type === "USER_INPUT" && step.content) {
        // Clear any unmatched tools from previous turn so tool outputs never drift across turns
        pendingTools.length = 0;
        let text = step.content;
        const m = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
        if (m) text = m[1].trim();
        items.push({
          id: "hist-u-" + step.step_index,
          kind: "user",
          text,
          createdAt: step.created_at || null,
        });
      } else if (step.type === "CHECKPOINT" && step.content) {
        pendingTools.length = 0;
        items.push({
          id: "hist-ck-" + step.step_index,
          kind: "checkpoint",
          title: "上下文已压缩 (/compact 检查点)",
          text: String(step.content || "").trim(),
          createdAt: step.created_at || null,
        });
      } else if (step.type === "ERROR_MESSAGE") {
        const errText = String(step.error || step.content || "").trim();
        if (errText) {
          items.push({
            id: "hist-err-" + step.step_index,
            kind: "notice",
            level: "error",
            text: errText,
            createdAt: step.created_at || null,
          });
        }
      } else if (step.type === "PLANNER_RESPONSE") {
        if (step.thinking && step.thinking.trim()) {
          items.push({
            id: "hist-th-" + step.step_index,
            kind: "thought",
            text: step.thinking.trim(),
            done: true,
            createdAt: step.created_at || null,
          });
        }
        if (Array.isArray(step.tool_calls)) {
          for (let i = 0; i < step.tool_calls.length; i++) {
            const tc = step.tool_calls[i];
            const toolItem = {
              id: "hist-tc-" + step.step_index + "-" + i,
              kind: "tool",
              toolCallId: "hist-tc-" + step.step_index + "-" + i,
              name: tc.name || "tool",
              title: tc.name || "tool",
              args: tc.args || {},
              status: "completed",
              output: "",
              createdAt: step.created_at || null,
            };
            items.push(toolItem);
            pendingTools.push(toolItem);
          }
        }
        if (step.content && step.content.trim()) {
          items.push({
            id: "hist-m-" + step.step_index,
            kind: "message",
            text: step.content,
            done: true,
            createdAt: step.created_at || null,
          });
        }
      } else if (step.type === "GENERIC" && step.source === "MODEL") {
        const parts = [];
        if (step.content && String(step.content).trim()) parts.push(String(step.content));
        if (step.error && String(step.error).trim()) parts.push("[Error]\n" + String(step.error));
        const combined = parts.join("\n\n");
        if (combined) {
          if (pendingTools.length > 0) {
            const t = pendingTools.shift();
            t.output = combined;
            if (step.error) t.status = "failed";
          } else {
            items.push({
              id: "hist-gen-" + step.step_index,
              kind: "tool",
              toolCallId: "hist-gen-" + step.step_index,
              name: "tool_output",
              title: "工具回传输出",
              args: {},
              status: step.error ? "failed" : "completed",
              output: combined,
              createdAt: step.created_at || null,
            });
          }
        }
      }
    }
    return items;
  } catch (e) {
    console.error("[transcript] read error:", e.message);
    return null;
  }
}

class AcpBridge {
  constructor() {
    this.proc = null;
    this.decoder = new StringDecoder("utf8");
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.starting = null;
    this.agentInfo = null;
    this.capabilities = null;

    this.defaultCwd = normalizeCwd(process.env.AGY_CWD || process.cwd());
    this.defaultSessionId = null;
    // Multi-session concurrent state pool: sessionId -> SessionState
    this.sessions = new Map();
    // Global defaults shared across newly created sessions
    this.globalModels = [];
    this.globalModes = [];
    this.globalCommands = [];

    // Connected SSE clients
    this.sseClients = new Set();
    this.aliases = loadAliases();
    this.hiddenSessions = loadHiddenSessions();
    this.deletedInProcess = new Set();
    this.rpcLog = [];
    this.prefs = loadPreferences();
    this.sandbox = !!this.prefs.sandbox;
    this._suppressExitNotice = false;
  }

  get cwd() {
    const s = this.getSession(this.defaultSessionId);
    return s ? s.cwd : this.defaultCwd;
  }

  set cwd(v) {
    this.defaultCwd = normalizeCwd(v);
  }

  createSessionState(sessionId, cwd) {
    const s = {
      sessionId,
      cwd: normalizeCwd(cwd || this.defaultCwd),
      title: "新对话",
      models: this.globalModels.slice(),
      currentModelId: "",
      modes: this.globalModes.slice(),
      currentModeId: "",
      commands: this.globalCommands.slice(),
      usage: { used: 0, size: 1048576 },
      busy: false,
      replaying: false,
      loadedInAcp: false,
      items: [],
      toolMap: new Map(),
      pendingPermissions: new Map(),
      unreadDone: false,
    };
    this.sessions.set(sessionId, s);
    return s;
  }

  getSession(sessionId) {
    const id = sessionId || this.defaultSessionId;
    return id ? this.sessions.get(id) || null : null;
  }

  getOrCreateSession(sessionId, cwd) {
    let s = this.sessions.get(sessionId);
    if (!s) s = this.createSessionState(sessionId, cwd);
    return s;
  }

  getRuntimeStatuses() {
    const map = {};
    for (const [sid, s] of this.sessions) {
      if (s.busy || s.pendingPermissions.size > 0 || s.unreadDone) {
        map[sid] = {
          busy: s.busy,
          pendingPermCount: s.pendingPermissions.size,
          unreadDone: !!s.unreadDone,
        };
      }
    }
    return map;
  }

  broadcastStatuses() {
    this.broadcast("sessions_status", { statuses: this.getRuntimeStatuses() });
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch (_) {
        this.sseClients.delete(res);
      }
    }
  }

  getSnapshot(sessionId) {
    const s = this.getSession(sessionId);
    if (!s) {
      return {
        ready: this.ready,
        sandbox: this.sandbox,
        defaultMode: this.prefs.defaultMode || "",
        agentInfo: this.agentInfo,
        cwd: this.defaultCwd,
        sessionId: null,
        title: "新对话",
        rawTitle: "新对话",
        models: this.globalModels,
        currentModelId: "",
        modes: this.globalModes,
        currentModeId: "",
        commands: this.globalCommands,
        usage: { used: 0, size: 1048576 },
        busy: false,
        items: [],
        pendingPermissions: [],
        runtimeStatuses: this.getRuntimeStatuses(),
      };
    }
    return {
      ready: this.ready,
      sandbox: this.sandbox,
      defaultMode: this.prefs.defaultMode || "",
      agentInfo: this.agentInfo,
      cwd: s.cwd,
      sessionId: s.sessionId,
      title: this.aliases[s.sessionId] || s.title,
      rawTitle: s.title,
      models: s.models.length ? s.models : this.globalModels,
      currentModelId: s.currentModelId,
      modes: s.modes.length ? s.modes : this.globalModes,
      currentModeId: s.currentModeId,
      commands: s.commands.length ? s.commands : this.globalCommands,
      usage: s.usage,
      busy: s.busy,
      items: s.items,
      pendingPermissions: Array.from(s.pendingPermissions.values()),
      runtimeStatuses: this.getRuntimeStatuses(),
    };
  }

  async ensureStarted() {
    if (this.ready && this.proc && !this.proc.killed) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      this.spawnProcess();
      const initRes = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "agy-web", version: "1.0.0" },
      });
      this.agentInfo = initRes.agentInfo || { name: "Antigravity ACP" };
      this.capabilities = initRes.agentCapabilities || {};
      this.ready = true;
      this.broadcast("status", { ready: true, sandbox: this.sandbox, agentInfo: this.agentInfo });
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  spawnProcess() {
    if (this.proc && !this.proc.killed) {
      try {
        this._suppressExitNotice = true;
        this.proc.kill();
      } catch (_) {}
    }

    this.buf = "";
    this.decoder = new StringDecoder("utf8");
    // --process-per-session gives each concurrent session an isolated worker process
    const acpArgs = ["acp", "--process-per-session"];
    if (this.sandbox) acpArgs.push("--sandbox");
    const proc = spawn("agy", acpArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.defaultCwd,
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk) => {
      this.buf += this.decoder.write(chunk);
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        this.handleLine(line);
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error("[agy acp stderr]", text);
      }
    });

    proc.on("exit", (code, signal) => {
      const suppressed = this._suppressExitNotice;
      this._suppressExitNotice = false;
      if (this.proc && this.proc !== proc) return;
      console.error(`[agy acp] exited code=${code} signal=${signal}`);
      this.ready = false;
      for (const [, p] of this.pending) {
        p.reject(new Error(`ACP 进程意外退出 (code=${code})`));
      }
      this.pending.clear();
      for (const [, s] of this.sessions) {
        s.busy = false;
        s.loadedInAcp = false;
        s.pendingPermissions.clear();
      }
      if (!suppressed) {
        this.broadcast("error_notice", {
          message: `底层 agy acp 进程已退出 (code=${code})，发送消息或新建会话时会自动重启。`,
        });
      }
      this.broadcastStatuses();
      this.broadcast("status", { ready: false, sandbox: this.sandbox, agentInfo: this.agentInfo });
    });
  }

  sanitizeRpcForLog(obj) {
    try {
      const clone = JSON.parse(JSON.stringify(obj));
      if (Array.isArray(clone?.params?.prompt)) {
        clone.params.prompt = clone.params.prompt.map((b) =>
          b && b.type === "image" && typeof b.data === "string"
            ? { ...b, data: `<base64 image, ${b.data.length} chars>` }
            : b
        );
      }
      return clone;
    } catch (_) {
      return obj;
    }
  }

  sendRaw(obj) {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      throw new Error("ACP 进程未运行");
    }
    this.rpcLog.push({
      ts: new Date().toISOString(),
      direction: "client -> agy acp",
      method: obj.method || "(response)",
      payload: this.sanitizeRpcForLog(obj),
    });
    if (this.rpcLog.length > 100) {
      this.rpcLog.shift();
    }
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      try {
        this.sendRaw({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error("[acp parse err]", e.message, line.slice(0, 200));
      return;
    }

    // Response to our request
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // Incoming request from server (permission request)
    if (msg.method === "session/request_permission") {
      const sid = msg.params?.sessionId || this.defaultSessionId;
      const sess = sid ? this.getOrCreateSession(sid) : null;
      const perm = {
        rpcId: msg.id,
        sessionId: sid,
        toolCall: msg.params?.toolCall || {},
        options: msg.params?.options || [],
        createdAt: Date.now(),
      };
      if (sess) {
        sess.pendingPermissions.set(String(msg.id), perm);
      }
      this.broadcast("permission_request", perm);
      this.broadcastStatuses();
      return;
    }

    // Streaming updates routed strictly by sessionId
    if (msg.method === "session/update") {
      const params = msg.params || {};
      const sid = params.sessionId || this.defaultSessionId;
      if (!sid) return;
      const sess = this.getOrCreateSession(sid);
      this.handleSessionUpdate(sess, params.update || {});
    }
  }

  markTrailingStreamsDone(sess) {
    if (!sess) return;
    const last = sess.items[sess.items.length - 1];
    if (last && (last.kind === "thought" || last.kind === "message") && !last.done) {
      last.done = true;
      last.endedAt = Date.now();
    }
  }

  handleSessionUpdate(sess, update) {
    const type = update.sessionUpdate;
    const sid = sess.sessionId;

    if (type === "agent_thought_chunk") {
      const text = update.content?.text || "";
      if (!text) return;
      let last = sess.items[sess.items.length - 1];
      if (!last || last.kind !== "thought" || last.done) {
        this.markTrailingStreamsDone(sess);
        last = {
          id: "th-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          kind: "thought",
          text: "",
          done: false,
          startedAt: Date.now(),
        };
        sess.items.push(last);
      }
      last.text += text;
      if (!sess.replaying) {
        this.broadcast("item_delta", {
          sessionId: sid,
          id: last.id,
          kind: "thought",
          delta: text,
          startedAt: last.startedAt,
        });
      }
      return;
    }

    if (type === "agent_message_chunk") {
      const text = update.content?.text || "";
      if (!text) return;
      let last = sess.items[sess.items.length - 1];
      if (!last || last.kind !== "message" || last.done) {
        this.markTrailingStreamsDone(sess);
        last = {
          id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          kind: "message",
          text: "",
          done: false,
          startedAt: Date.now(),
        };
        sess.items.push(last);
      }
      last.text += text;
      if (!sess.replaying) {
        this.broadcast("item_delta", {
          sessionId: sid,
          id: last.id,
          kind: "message",
          delta: text,
          startedAt: last.startedAt,
        });
      }
      return;
    }

    if (type === "user_message_chunk") {
      const text = update.content?.text || "";
      if (!text) return;
      let last = sess.items[sess.items.length - 1];
      if (!last || last.kind !== "user") {
        this.markTrailingStreamsDone(sess);
        last = {
          id: "usr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          kind: "user",
          text: "",
          createdAt: new Date().toISOString(),
        };
        sess.items.push(last);
      }
      last.text += text;
      return;
    }

    if (type === "tool_call" || type === "tool_call_update") {
      this.markTrailingStreamsDone(sess);
      const tcId = update.toolCallId || "tc-" + Date.now();
      let item = sess.toolMap.get(tcId);
      const outputText = this.extractToolOutput(update);
      if (!item) {
        item = {
          id: tcId,
          kind: "tool",
          toolCallId: tcId,
          name: update.name || update.title || "tool",
          title: update.title || update.name || "tool",
          toolKind: update.kind || "",
          args: update.args || update.rawInput || {},
          status: update.status || "in_progress",
          output: outputText,
          startedAt: Date.now(),
        };
        sess.toolMap.set(tcId, item);
        sess.items.push(item);
      } else {
        if (update.name) item.name = update.name;
        if (update.title) item.title = update.title;
        if (update.kind) item.toolKind = update.kind;
        const nextArgs = update.args || update.rawInput;
        if (nextArgs && (typeof nextArgs !== "object" || Object.keys(nextArgs).length > 0)) {
          item.args = nextArgs;
        }
        if (update.status) item.status = update.status;
        if (outputText) {
          // Preserve earlier output if an update only sends a small error/tail
          item.output = outputText;
        }
        if (update.status === "completed" || update.status === "failed") {
          item.endedAt = Date.now();
        }
      }
      if (!sess.replaying) {
        this.broadcast("tool_upsert", { sessionId: sid, item });
      }
      return;
    }

    if (type === "usage_update") {
      sess.usage = {
        used: update.used ?? sess.usage.used,
        size: update.size ?? sess.usage.size,
      };
      if (!sess.replaying) {
        this.broadcast("usage", { sessionId: sid, ...sess.usage });
      }
      return;
    }

    if (type === "session_info_update") {
      if (update.title) {
        sess.title = update.title;
        if (!sess.replaying) {
          this.broadcast("session_info", {
            sessionId: sid,
            title: this.aliases[sid] || sess.title,
            rawTitle: sess.title,
          });
        }
      }
      return;
    }

    if (type === "available_commands_update") {
      if (Array.isArray(update.availableCommands)) {
        sess.commands = update.availableCommands;
        this.globalCommands = update.availableCommands;
        if (!sess.replaying) {
          this.broadcast("commands", { sessionId: sid, commands: sess.commands });
        }
      }
      return;
    }

    if (type === "config_option_update" && Array.isArray(update.configOptions)) {
      this.broadcast("config_options", { sessionId: sid, configOptions: update.configOptions });
    }
  }

  extractToolOutput(update) {
    const parts = [];
    if (update.rawOutput) {
      if (typeof update.rawOutput === "string") {
        if (update.rawOutput.trim()) parts.push(update.rawOutput);
      } else if (typeof update.rawOutput === "object") {
        if (typeof update.rawOutput.output === "string" && update.rawOutput.output.trim()) {
          parts.push(update.rawOutput.output);
        } else if (typeof update.rawOutput.stdout === "string" || typeof update.rawOutput.stderr === "string") {
          if (update.rawOutput.stdout) parts.push(update.rawOutput.stdout);
          if (update.rawOutput.stderr) parts.push("[stderr]\n" + update.rawOutput.stderr);
        } else {
          try {
            const s = JSON.stringify(update.rawOutput, null, 2);
            if (s && s !== "{}") parts.push(s);
          } catch (_) {}
        }
        if (typeof update.rawOutput.error === "string" && update.rawOutput.error.trim()) {
          parts.push("[error]\n" + update.rawOutput.error);
        }
      }
    }
    if (Array.isArray(update.content)) {
      for (const c of update.content) {
        if (!c) continue;
        if (c.type === "diff") {
          const head = c.path ? `--- ${c.path}\n+++ ${c.path}\n` : "";
          const oldLines = c.oldText ? String(c.oldText).split(/\r?\n/).map((l) => "-" + l).join("\n") : "";
          const newLines = c.newText ? String(c.newText).split(/\r?\n/).map((l) => "+" + l).join("\n") : "";
          const block = [head + oldLines, newLines].filter(Boolean).join("\n");
          if (block.trim()) parts.push(block);
        } else if (c?.content?.text) {
          parts.push(c.content.text);
        } else if (c?.text) {
          parts.push(c.text);
        } else if (c?.resource?.text) {
          parts.push(c.resource.text);
        }
      }
    }
    if (typeof update.error === "string" && update.error.trim()) {
      parts.push("[error]\n" + update.error);
    }
    return parts.join("\n\n");
  }

  applySessionMetadata(sess, res) {
    if (res.models) {
      if (Array.isArray(res.models.availableModels) && res.models.availableModels.length) {
        sess.models = res.models.availableModels;
        this.globalModels = res.models.availableModels;
      }
      if (res.models.currentModelId) sess.currentModelId = res.models.currentModelId;
    }
    if (res.modes) {
      if (Array.isArray(res.modes.availableModes) && res.modes.availableModes.length) {
        sess.modes = res.modes.availableModes;
        this.globalModes = res.modes.availableModes;
      }
      if (res.modes.currentModeId) sess.currentModeId = res.modes.currentModeId;
    }
  }

  async applyRememberedDefaultMode(sess) {
    const preferred = this.prefs.defaultMode;
    if (!sess || !preferred || sess.currentModeId === preferred) return;
    const avail = sess.modes.length ? sess.modes : this.globalModes;
    if (avail.length && !avail.some((m) => m.id === preferred)) return;
    try {
      await this.request("session/set_mode", {
        sessionId: sess.sessionId,
        modeId: preferred,
      });
      sess.currentModeId = preferred;
    } catch (e) {
      console.error("[prefs] apply default mode failed:", e.message);
    }
  }

  async newSession(cwd) {
    await this.ensureStarted();
    const targetCwd = normalizeCwd(cwd || this.defaultCwd);
    if (!fs.existsSync(targetCwd)) {
      throw new Error(`目录不存在: ${targetCwd}`);
    }
    this.defaultCwd = targetCwd;
    const res = await this.request("session/new", {
      cwd: targetCwd,
      mcpServers: [],
    });
    const sess = this.createSessionState(res.sessionId, targetCwd);
    sess.loadedInAcp = true;
    this.defaultSessionId = sess.sessionId;
    this.applySessionMetadata(sess, res);
    await this.applyRememberedDefaultMode(sess);
    this.broadcastStatuses();
    return this.getSnapshot(sess.sessionId);
  }

  async listSessions(cwd) {
    await this.ensureStarted();
    const targetCwd = normalizeCwd(cwd || this.defaultCwd);
    const res = await this.request("session/list", { cwd: targetCwd });
    const seen = new Set();
    const sessions = (res.sessions || [])
      .filter((s) => !this.deletedInProcess.has(s.sessionId))
      .map((s) => {
        seen.add(s.sessionId);
        const mem = this.sessions.get(s.sessionId);
        return {
          sessionId: s.sessionId,
          cwd: normalizeCwd(s.cwd || targetCwd),
          rawTitle: s.title || mem?.title || "未命名对话",
          title: this.aliases[s.sessionId] || s.title || mem?.title || "未命名对话",
          updatedAt: s.updatedAt || "",
          hidden: this.hiddenSessions.has(s.sessionId),
          busy: mem ? mem.busy : false,
          pendingPermCount: mem ? mem.pendingPermissions.size : 0,
          unreadDone: mem ? !!mem.unreadDone : false,
        };
      });

    // Also include freshly created in-memory sessions in this cwd that haven't been persisted yet
    for (const [sid, mem] of this.sessions) {
      if (seen.has(sid) || this.deletedInProcess.has(sid)) continue;
      if (mem.cwd.toLowerCase() === targetCwd.toLowerCase()) {
        sessions.unshift({
          sessionId: sid,
          cwd: mem.cwd,
          rawTitle: mem.title || "新对话",
          title: this.aliases[sid] || mem.title || "新对话",
          updatedAt: new Date().toISOString(),
          hidden: this.hiddenSessions.has(sid),
          busy: mem.busy,
          pendingPermCount: mem.pendingPermissions.size,
          unreadDone: !!mem.unreadDone,
        });
      }
    }

    const hiddenCount = sessions.filter((s) => s.hidden).length;
    return { cwd: targetCwd, sessions, hiddenCount, runtimeStatuses: this.getRuntimeStatuses() };
  }

  syncFromLocalTranscript(sess, force = false) {
    if (!sess || !sess.sessionId || sess.busy || sess.replaying) return false;
    const transcriptItems = readLocalTranscript(sess.sessionId);
    if (!transcriptItems || !transcriptItems.length) return false;

    const countCore = (arr) => arr.filter((i) => i.kind === "user" || i.kind === "message").length;
    const countThoughts = (arr) => arr.filter((i) => i.kind === "thought").length;
    const countTotalChars = (arr) =>
      arr.reduce((sum, i) => sum + (i.text ? i.text.length : 0) + (i.output ? i.output.length : 0), 0);

    const diskCore = countCore(transcriptItems);
    const memCore = countCore(sess.items);
    const diskThoughts = countThoughts(transcriptItems);
    const memThoughts = countThoughts(sess.items);
    const diskChars = countTotalChars(transcriptItems);
    const memChars = countTotalChars(sess.items);

    const shouldReplace =
      force ||
      transcriptItems.length > sess.items.length ||
      diskCore > memCore ||
      diskThoughts > memThoughts ||
      (diskCore >= memCore && diskChars > memChars);

    if (shouldReplace) {
      sess.items = transcriptItems;
      sess.toolMap.clear();
      for (const it of sess.items) {
        if (it.kind === "tool") sess.toolMap.set(it.toolCallId, it);
      }
      return true;
    }
    return false;
  }

  async loadSession(sessionId, cwd) {
    await this.ensureStarted();
    const targetCwd = normalizeCwd(cwd || this.defaultCwd);
    const existing = this.sessions.get(sessionId);

    // If this session is already live in memory (e.g. running in background or recently viewed), switch instantly without interrupting anything!
    if (existing && existing.loadedInAcp) {
      existing.unreadDone = false;
      this.defaultSessionId = sessionId;
      if (!existing.busy) {
        this.syncFromLocalTranscript(existing);
      }
      this.broadcastStatuses();
      return this.getSnapshot(sessionId);
    }

    const sess = this.createSessionState(sessionId, targetCwd);
    sess.replaying = true;
    this.defaultSessionId = sessionId;

    let res;
    try {
      res = await this.request("session/load", {
        sessionId,
        cwd: targetCwd,
        mcpServers: [],
      });
      sess.loadedInAcp = true;
    } catch (e) {
      this.sessions.delete(sessionId);
      throw e;
    } finally {
      sess.replaying = false;
    }

    this.markTrailingStreamsDone(sess);
    this.applySessionMetadata(sess, res || {});
    await this.applyRememberedDefaultMode(sess);
    this.syncFromLocalTranscript(sess);

    if (this.aliases[sessionId]) {
      sess.title = this.aliases[sessionId];
    } else if (!sess.title || sess.title === "新对话") {
      try {
        const listed = await this.listSessions(targetCwd);
        const found = listed.sessions.find((s) => s.sessionId === sessionId);
        if (found) sess.title = found.rawTitle;
      } catch (_) {}
    }

    this.broadcastStatuses();
    return this.getSnapshot(sessionId);
  }

  async setModel(sessionId, modelId) {
    await this.ensureStarted();
    let sess = this.getSession(sessionId);
    if (!sess) {
      const snap = await this.newSession(this.defaultCwd);
      sess = this.getSession(snap.sessionId);
    }
    await this.request("session/set_model", {
      sessionId: sess.sessionId,
      modelId,
    });
    sess.currentModelId = modelId;
    this.broadcast("meta_update", {
      sessionId: sess.sessionId,
      currentModelId: sess.currentModelId,
      currentModeId: sess.currentModeId,
    });
    return { sessionId: sess.sessionId, currentModelId: sess.currentModelId };
  }

  async setMode(sessionId, modeId) {
    await this.ensureStarted();
    let sess = this.getSession(sessionId);
    if (!sess) {
      const snap = await this.newSession(this.defaultCwd);
      sess = this.getSession(snap.sessionId);
    }
    await this.request("session/set_mode", {
      sessionId: sess.sessionId,
      modeId,
    });
    sess.currentModeId = modeId;
    // Persist as the remembered default execution mode for future sessions
    this.prefs.defaultMode = modeId;
    savePreferences(this.prefs);
    this.broadcast("meta_update", {
      sessionId: sess.sessionId,
      currentModelId: sess.currentModelId,
      currentModeId: sess.currentModeId,
      defaultMode: this.prefs.defaultMode,
    });
    return { sessionId: sess.sessionId, currentModeId: sess.currentModeId, defaultMode: this.prefs.defaultMode };
  }

  async setSandbox(enabled, activeSessionId) {
    const nextVal = !!enabled;
    for (const [, s] of this.sessions) {
      if (s.busy) {
        throw new Error("当前有会话正在执行中，请先等待完成或点击停止后再切换沙箱模式。");
      }
    }
    const prevSess = this.getSession(activeSessionId);
    const prevSid = prevSess ? prevSess.sessionId : this.defaultSessionId;
    const prevCwd = prevSess ? prevSess.cwd : this.defaultCwd;
    const hadItems = prevSess ? prevSess.items.length > 0 : false;

    this.sandbox = nextVal;
    this.prefs.sandbox = nextVal;
    savePreferences(this.prefs);

    // Gracefully restart underlying agy acp with/without --sandbox
    if (this.proc && !this.proc.killed) {
      this._suppressExitNotice = true;
      try {
        this.proc.kill();
      } catch (_) {}
      this.proc = null;
    }
    this.ready = false;
    this.starting = null;
    for (const [, p] of this.pending) {
      p.reject(new Error("正在切换沙箱并重启 ACP"));
    }
    this.pending.clear();
    for (const [, s] of this.sessions) {
      s.loadedInAcp = false;
      s.pendingPermissions.clear();
    }

    await this.ensureStarted();

    let snapshot = null;
    if (prevSid && hadItems) {
      try {
        snapshot = await this.loadSession(prevSid, prevCwd);
      } catch (_) {
        snapshot = await this.newSession(prevCwd);
      }
    } else {
      snapshot = await this.newSession(prevCwd);
    }

    this.broadcast("sandbox_update", { sandbox: this.sandbox });
    return { ok: true, sandbox: this.sandbox, snapshot };
  }

  renameSession(sessionId, customTitle) {
    const id = sessionId || this.defaultSessionId;
    if (!id) throw new Error("没有指定会话 ID");
    const trimmed = String(customTitle || "").trim();
    if (trimmed) {
      this.aliases[id] = trimmed;
    } else {
      delete this.aliases[id];
    }
    saveAliases(this.aliases);
    const sess = this.sessions.get(id);
    const rawTitle = sess ? sess.title : "";
    this.broadcast("session_info", {
      sessionId: id,
      title: this.aliases[id] || rawTitle || "未命名对话",
      rawTitle,
    });
    return { sessionId: id, title: this.aliases[id] || rawTitle };
  }

  setSessionHidden(sessionId, hidden) {
    if (!isValidSessionId(sessionId)) throw new Error("无效的会话 ID");
    if (hidden) {
      this.hiddenSessions.add(sessionId);
    } else {
      this.hiddenSessions.delete(sessionId);
    }
    saveHiddenSessions(this.hiddenSessions);
    return { sessionId, hidden: this.hiddenSessions.has(sessionId) };
  }

  async deleteSessionPermanently(sessionId, activeSessionId) {
    if (!isValidSessionId(sessionId)) throw new Error("无效的会话 ID");
    const sess = this.sessions.get(sessionId);
    if (sess && (sess.busy || sess.pendingPermissions.size > 0)) {
      this.cancelTurn(sessionId);
    }

    try {
      if (this.ready && this.proc && !this.proc.killed) {
        await this.request("session/close", { sessionId }).catch(() => {});
      }
    } catch (_) {}

    const cliRoot = path.join(os.homedir(), ".gemini", "antigravity-cli");
    const removed = [];
    const errors = [];

    const tryRemove = (targetPath) => {
      try {
        if (fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { recursive: true, force: true });
          removed.push(targetPath);
        }
      } catch (e) {
        errors.push(`${targetPath}: ${e.message}`);
      }
    };

    tryRemove(path.join(cliRoot, "brain", sessionId));
    for (const sub of ["conversations", "annotations"]) {
      const dir = path.join(cliRoot, sub);
      try {
        if (fs.existsSync(dir)) {
          for (const entry of fs.readdirSync(dir)) {
            if (entry === sessionId || entry.startsWith(sessionId + ".")) {
              tryRemove(path.join(dir, entry));
            }
          }
        }
      } catch (e) {
        errors.push(`${dir}: ${e.message}`);
      }
    }

    this.sessions.delete(sessionId);
    delete this.aliases[sessionId];
    saveAliases(this.aliases);
    this.hiddenSessions.delete(sessionId);
    saveHiddenSessions(this.hiddenSessions);
    this.deletedInProcess.add(sessionId);

    let nextSnapshot = null;
    if (sessionId === activeSessionId || sessionId === this.defaultSessionId) {
      this.defaultSessionId = null;
      nextSnapshot = await this.newSession(this.defaultCwd);
    }
    this.broadcastStatuses();

    return {
      ok: true,
      sessionId,
      removedCount: removed.length,
      errors,
      snapshot: nextSnapshot,
    };
  }

  async sendPrompt(sessionId, text, images = []) {
    await this.ensureStarted();
    let sess = this.getSession(sessionId);
    if (!sess) {
      const snap = await this.newSession(this.defaultCwd);
      sess = this.getSession(snap.sessionId);
    }
    if (!sess.loadedInAcp) {
      await this.loadSession(sess.sessionId, sess.cwd);
      sess = this.getSession(sess.sessionId);
    }
    if (sess.busy) {
      throw new Error("当前会话正在生成回复，你可以切换到其他会话并行发任务，或先点击停止。");
    }

    const promptBlocks = [];
    if (text && text.trim()) {
      promptBlocks.push({ type: "text", text });
    }
    for (const img of images) {
      if (img && img.data && img.mimeType) {
        promptBlocks.push({
          type: "image",
          data: img.data,
          mimeType: img.mimeType,
        });
      }
    }
    if (promptBlocks.length === 0) {
      throw new Error("消息内容不能为空");
    }

    const sid = sess.sessionId;
    const userItem = {
      id: "usr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      kind: "user",
      text: text || "",
      images: images.map((im) => ({
        mimeType: im.mimeType,
        preview: `data:${im.mimeType};base64,${im.data}`,
      })),
      createdAt: new Date().toISOString(),
    };
    sess.items.push(userItem);
    sess.busy = true;
    sess.unreadDone = false;
    this.broadcast("user_item", { sessionId: sid, item: userItem });
    this.broadcast("busy", { sessionId: sid, busy: true });
    this.broadcastStatuses();

    // Run prompt asynchronously per session so multiple sessions execute truly in parallel
    this.request("session/prompt", {
      sessionId: sid,
      prompt: promptBlocks,
    })
      .then((res) => {
        this.markTrailingStreamsDone(sess);
        sess.busy = false;
        sess.unreadDone = sid !== this.defaultSessionId;
        sess.pendingPermissions.clear();
        this.broadcast("turn_done", {
          sessionId: sid,
          stopReason: res?.stopReason || "end_turn",
          usage: res?.usage || null,
        });
        this.broadcast("busy", { sessionId: sid, busy: false });
        this.broadcastStatuses();
      })
      .catch((err) => {
        this.markTrailingStreamsDone(sess);
        sess.busy = false;
        sess.pendingPermissions.clear();
        this.broadcast("error_notice", { sessionId: sid, message: err.message });
        this.broadcast("busy", { sessionId: sid, busy: false });
        this.broadcastStatuses();
      });

    return { ok: true, sessionId: sid };
  }

  cancelTurn(sessionId) {
    const sess = this.getSession(sessionId);
    if (!sess || !this.proc) return { ok: false };
    const sid = sess.sessionId;
    try {
      this.notify("session/cancel", { sessionId: sid });
    } catch (_) {}
    for (const [key, perm] of sess.pendingPermissions) {
      try {
        this.sendRaw({
          jsonrpc: "2.0",
          id: perm.rpcId,
          result: { outcome: { outcome: "cancelled" } },
        });
      } catch (_) {}
      sess.pendingPermissions.delete(key);
    }
    this.broadcast("permissions_cleared", { sessionId: sid });
    this.broadcastStatuses();
    return { ok: true };
  }

  respondPermission(sessionId, rpcId, optionId) {
    const key = String(rpcId);
    let targetSess = this.getSession(sessionId);
    let perm = targetSess ? targetSess.pendingPermissions.get(key) : null;
    if (!perm) {
      // Search across all sessions just in case
      for (const [, s] of this.sessions) {
        if (s.pendingPermissions.has(key)) {
          targetSess = s;
          perm = s.pendingPermissions.get(key);
          break;
        }
      }
    }
    if (!perm || !targetSess) {
      throw new Error("该权限请求已失效或已处理");
    }
    targetSess.pendingPermissions.delete(key);
    if (!optionId || optionId === "__cancel__") {
      this.sendRaw({
        jsonrpc: "2.0",
        id: perm.rpcId,
        result: { outcome: { outcome: "cancelled" } },
      });
    } else {
      this.sendRaw({
        jsonrpc: "2.0",
        id: perm.rpcId,
        result: { outcome: { outcome: "selected", optionId } },
      });
    }
    this.broadcast("permission_resolved", { sessionId: targetSess.sessionId, rpcId: perm.rpcId, optionId });
    this.broadcastStatuses();
    return { ok: true };
  }

  shutdown() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch (_) {}
    }
  }
}

const bridge = new AcpBridge();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 25 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("无效 JSON 请求体"));
      }
    });
    req.on("error", reject);
  });
}

function redactSecrets(obj) {
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/(key|token|secret|password|authorization|cookie)/i.test(k) && typeof v === "string" && v.length > 0) {
        out[k] = "*** (已脱敏)";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return obj;
}

function parseSkillFrontmatter(md) {
  const m = String(md || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: "", description: "" };
  const fm = m[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  let desc = "";
  const descSingle = fm.match(/^description:\s*(?![>|])(.+)$/m);
  if (descSingle) {
    desc = descSingle[1].trim().replace(/^["']|["']$/g, "");
  } else {
    const descMulti = fm.match(/^description:\s*[>|]-?\r?\n((?:[ \t]+.*\r?\n?)+)/m);
    if (descMulti) {
      desc = descMulti[1].replace(/^[ \t]+/gm, "").replace(/\r?\n/g, " ").trim();
    }
  }
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : "",
    description: desc,
  };
}

function getWorkspaceAncestors(cwd) {
  const dirs = [];
  let cur = path.resolve(cwd || process.cwd());
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    dirs.push(cur);
    if (fs.existsSync(path.join(cur, ".git"))) break;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    // Stop walking above home dir if not inside a git repo
    if (cur.toLowerCase() === os.homedir().toLowerCase()) break;
    cur = parent;
  }
  return dirs;
}

const FILE_SCAN_IGNORE = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "out",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vs",
  "coverage",
  ".cache",
]);

let fileScanCache = { cwd: "", ts: 0, entries: [] };

function scanWorkspaceFiles(cwd, query = "") {
  const root = path.resolve(normalizeCwd(cwd));
  const now = Date.now();
  let entries;

  if (fileScanCache.cwd === root && now - fileScanCache.ts < 5000) {
    entries = fileScanCache.entries;
  } else {
    entries = [];
    const MAX_ENTRIES = 2500;
    const MAX_DEPTH = 6;
    const walk = (dir, relBase, depth) => {
      if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;
      let list;
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const d of list) {
        if (entries.length >= MAX_ENTRIES) break;
        if (FILE_SCAN_IGNORE.has(d.name)) continue;
        const rel = relBase ? `${relBase}/${d.name}` : d.name;
        const isDir = d.isDirectory();
        entries.push({ path: rel, name: d.name, isDir });
        if (isDir) {
          walk(path.join(dir, d.name), rel, depth + 1);
        }
      }
    };
    walk(root, "", 0);
    fileScanCache = { cwd: root, ts: now, entries };
  }

  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return entries.slice(0, 60);
  }
  const scored = [];
  for (const e of entries) {
    const pLow = e.path.toLowerCase();
    const nLow = e.name.toLowerCase();
    let score = 0;
    if (nLow === q) score = 100;
    else if (nLow.startsWith(q)) score = 80;
    else if (nLow.includes(q)) score = 60;
    else if (pLow.includes(q)) score = 40;
    if (score > 0) {
      scored.push({ e, score: score + (e.isDir ? -5 : 0) });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.e.path.length - b.e.path.length);
  return scored.slice(0, 60).map((s) => s.e);
}

function runGitCapture(cwd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch (_) {}
      resolve({ code: -1, stdout, stderr: "git timeout" });
    }, timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: e.message });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseUnifiedDiffByFile(diffText) {
  const map = new Map();
  if (!diffText) return map;
  const parts = diffText.split(/^diff --git /m);
  for (let i = 1; i < parts.length; i++) {
    const block = "diff --git " + parts[i];
    const firstLine = block.split(/\r?\n/, 1)[0] || "";
    const m = firstLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      const filePath = m[2].trim();
      const prev = map.get(filePath) || "";
      map.set(filePath, prev ? prev + "\n" + block : block);
    }
  }
  return map;
}

async function getWorkspaceDiff(cwd, sessionItems = []) {
  const root = path.resolve(normalizeCwd(cwd));
  const check = await runGitCapture(root, ["rev-parse", "--is-inside-work-tree"]);
  if (check.code === 0 && check.stdout.trim() === "true") {
    const [statusRes, diffRes, cachedRes] = await Promise.all([
      runGitCapture(root, ["status", "--porcelain"]),
      runGitCapture(root, ["diff", "--no-color"]),
      runGitCapture(root, ["diff", "--cached", "--no-color"]),
    ]);
    const diffMap = parseUnifiedDiffByFile(
      [diffRes.stdout, cachedRes.stdout].filter(Boolean).join("\n")
    );
    const files = [];
    for (const rawLine of statusRes.stdout.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const code = rawLine.slice(0, 2).trim() || "M";
      let filePath = rawLine.slice(3).trim();
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop().trim();
      }
      filePath = filePath.replace(/^"|"$/g, "");
      let diff = diffMap.get(filePath) || "";
      if (!diff && code === "??") {
        // Preview untracked new file
        try {
          const full = path.join(root, filePath);
          if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) {
            const stat = fs.statSync(full);
            if (stat.size <= 512 * 1024) {
              const contentLines = fs.readFileSync(full, "utf8").split(/\r?\n/).slice(0, 300);
              diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${contentLines.length} @@\n` +
                contentLines.map((l) => "+" + l).join("\n");
            } else {
              diff = `(新增大文件，共 ${Math.round(stat.size / 1024)} KB，略过全文预览)`;
            }
          }
        } catch (_) {}
      }
      files.push({ status: code, path: filePath, diff: diff || "(无文本差异或为二进制文件)" });
    }
    return { isGit: true, cwd: root, files };
  }

  // Fallback for non-git workspaces: summarize files edited/written in current session tools
  const touched = new Map();
  for (const it of sessionItems || []) {
    if (it.kind !== "tool") continue;
    const name = String(it.name || "");
    if (!/(write_file|edit_file|replace_file|multi_replace)/i.test(name)) continue;
    const p = it.args?.Path || it.args?.TargetFile || it.args?.path || "";
    if (!p) continue;
    const cleanP = String(p).replace(/^"|"$/g, "");
    const rel = cleanP.toLowerCase().startsWith(root.toLowerCase())
      ? path.relative(root, cleanP).replace(/\\/g, "/")
      : cleanP;
    const prev = touched.get(rel) || { status: name.includes("write") ? "A" : "M", path: rel, ops: [] };
    if (it.args?.Target || it.args?.Replacement) {
      const tLines = String(it.args.Target || "").split(/\r?\n/).map((l) => "-" + l).join("\n");
      const rLines = String(it.args.Replacement || "").split(/\r?\n/).map((l) => "+" + l).join("\n");
      prev.ops.push(`@@ ${name} @@\n${tLines}\n${rLines}`);
    } else if (it.args?.Content) {
      const cLines = String(it.args.Content).split(/\r?\n/).slice(0, 150).map((l) => "+" + l).join("\n");
      prev.ops.push(`@@ ${name} @@\n${cLines}`);
    }
    touched.set(rel, prev);
  }
  const files = Array.from(touched.values()).map((f) => ({
    status: f.status,
    path: f.path,
    diff: f.ops.join("\n\n") || "(本会话已修改，当前目录非 Git 仓库)",
  }));
  return { isGit: false, cwd: root, files };
}

function isAllowedRuleSavePath(cwd, targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const resolved = path.resolve(targetPath);
  const home = os.homedir();
  const geminiRoot = path.join(home, ".gemini");
  const norm = (p) => path.resolve(p).toLowerCase();

  // Allowed global rule paths
  const allowedExact = new Set([
    norm(path.join(geminiRoot, "GEMINI.md")),
    norm(path.join(geminiRoot, "config", "GEMINI.md")),
    norm(path.join(geminiRoot, "config", "AGENTS.md")),
  ]);
  const allowedRuleDirs = [norm(path.join(geminiRoot, "config", "rules"))];

  for (const dir of getWorkspaceAncestors(cwd)) {
    allowedExact.add(norm(path.join(dir, "GEMINI.md")));
    allowedExact.add(norm(path.join(dir, "AGENTS.md")));
    for (const ad of [".agents", ".agent", "_agents", "_agent"]) {
      allowedRuleDirs.push(norm(path.join(dir, ad, "rules")));
    }
  }

  const rNorm = norm(resolved);
  if (allowedExact.has(rNorm)) return true;
  if (rNorm.endsWith(".md")) {
    const parentNorm = norm(path.dirname(resolved));
    if (allowedRuleDirs.includes(parentNorm)) return true;
  }
  return false;
}

function saveRuleFile(cwd, targetPath, content) {
  if (!isAllowedRuleSavePath(cwd, targetPath)) {
    throw new Error("安全拦截：仅允许保存全局或当前工作区白名单内的规则文件 (.md)");
  }
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolved, String(content ?? ""), "utf8");
  return { ok: true, path: resolved, customizations: readEffectiveCustomizations(cwd) };
}

function readEffectiveCustomizations(cwd) {
  const home = os.homedir();
  const geminiRoot = path.join(home, ".gemini");
  const rules = [];
  const customSkills = [];
  const builtinSkills = [];
  const mcpFiles = [];
  let settings = null;
  const seenPaths = new Set();

  const pushRule = (filePath, scope, label) => {
    try {
      const resolved = path.resolve(filePath);
      if (seenPaths.has(resolved) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return;
      seenPaths.add(resolved);
      const content = fs.readFileSync(resolved, "utf8");
      rules.push({
        scope,
        label,
        path: resolved,
        chars: content.length,
        content,
      });
    } catch (_) {}
  };

  const scanSkillsDir = (dirPath, scope, targetArr) => {
    try {
      if (!fs.existsSync(dirPath)) return;
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(dirPath, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        const resolved = path.resolve(skillFile);
        if (seenPaths.has(resolved)) continue;
        seenPaths.add(resolved);
        const content = fs.readFileSync(resolved, "utf8");
        const fm = parseSkillFrontmatter(content);
        targetArr.push({
          scope,
          name: fm.name || entry.name,
          description: fm.description || "",
          path: resolved,
          chars: content.length,
        });
      }
    } catch (_) {}
  };

  const pushMcpFile = (filePath, scope) => {
    try {
      const resolved = path.resolve(filePath);
      if (seenPaths.has(resolved) || !fs.existsSync(resolved)) return;
      seenPaths.add(resolved);
      const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
      const serversObj = parsed.mcpServers || parsed.servers || {};
      const serverNames = Object.keys(serversObj);
      mcpFiles.push({
        scope,
        path: resolved,
        serverCount: serverNames.length,
        servers: serverNames,
        config: redactSecrets(parsed),
      });
    } catch (_) {}
  };

  // 1. Workspace rules / skills / mcp (highest priority)
  const ancestors = getWorkspaceAncestors(cwd);
  const agentDirNames = [".agents", ".agent", "_agents", "_agent"];
  for (const dir of ancestors) {
    pushRule(path.join(dir, "GEMINI.md"), "项目级", "GEMINI.md");
    pushRule(path.join(dir, "AGENTS.md"), "项目级", "AGENTS.md");
    for (const ad of agentDirNames) {
      const rulesDir = path.join(dir, ad, "rules");
      try {
        if (fs.existsSync(rulesDir)) {
          for (const f of fs.readdirSync(rulesDir)) {
            if (f.toLowerCase().endsWith(".md")) {
              pushRule(path.join(rulesDir, f), "项目级", `${ad}/rules/${f}`);
            }
          }
        }
      } catch (_) {}
      scanSkillsDir(path.join(dir, ad, "skills"), "项目级", customSkills);
      pushMcpFile(path.join(dir, ad, "mcp_config.json"), "项目级");
    }
  }

  // 2. Global rules / skills / mcp
  pushRule(path.join(geminiRoot, "GEMINI.md"), "全局级", "~/.gemini/GEMINI.md");
  pushRule(path.join(geminiRoot, "config", "GEMINI.md"), "全局级", "~/.gemini/config/GEMINI.md");
  pushRule(path.join(geminiRoot, "config", "AGENTS.md"), "全局级", "~/.gemini/config/AGENTS.md");
  try {
    const globalRulesDir = path.join(geminiRoot, "config", "rules");
    if (fs.existsSync(globalRulesDir)) {
      for (const f of fs.readdirSync(globalRulesDir)) {
        if (f.toLowerCase().endsWith(".md")) {
          pushRule(path.join(globalRulesDir, f), "全局级", `config/rules/${f}`);
        }
      }
    }
  } catch (_) {}
  scanSkillsDir(path.join(geminiRoot, "config", "skills"), "全局级", customSkills);
  pushMcpFile(path.join(geminiRoot, "config", "mcp_config.json"), "全局级");
  pushMcpFile(path.join(geminiRoot, "antigravity-cli", "mcp_config.json"), "全局级");
  pushMcpFile(path.join(geminiRoot, "antigravity", "mcp_config.json"), "全局级");

  // 3. Built-in skills metadata
  scanSkillsDir(path.join(geminiRoot, "antigravity-cli", "builtin", "skills"), "内置", builtinSkills);

  // 4. CLI settings.json
  try {
    const settingsPath = path.join(geminiRoot, "antigravity-cli", "settings.json");
    if (fs.existsSync(settingsPath)) {
      settings = {
        path: settingsPath,
        data: redactSecrets(JSON.parse(fs.readFileSync(settingsPath, "utf8"))),
      };
    }
  } catch (_) {}

  const totalRuleChars = rules.reduce((sum, r) => sum + r.chars, 0);
  const totalMcpServers = mcpFiles.reduce((sum, m) => sum + m.serverCount, 0);

  return {
    cwd: normalizeCwd(cwd),
    summary: {
      ruleCount: rules.length,
      totalRuleChars,
      customSkillCount: customSkills.length,
      builtinSkillCount: builtinSkills.length,
      mcpServerCount: totalMcpServers,
    },
    rules,
    customSkills,
    builtinSkills,
    mcpFiles,
    settings,
  };
}

function readRawTranscriptSteps(sessionId) {
  if (!sessionId) return { file: null, steps: [] };
  try {
    const baseDir = path.join(
      os.homedir(),
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs"
    );
    const fullPath = path.join(baseDir, "transcript_full.jsonl");
    const compactPath = path.join(baseDir, "transcript.jsonl");
    const targetPath = fs.existsSync(fullPath)
      ? fullPath
      : fs.existsSync(compactPath)
        ? compactPath
        : null;
    if (!targetPath) return { file: null, steps: [] };

    const raw = fs.readFileSync(targetPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const steps = [];
    for (const line of lines) {
      try {
        const s = JSON.parse(line);
        steps.push({
          step_index: s.step_index,
          source: s.source || "",
          type: s.type || "",
          status: s.status || "",
          created_at: s.created_at || "",
          model: s.model || "",
          input_tokens: s.input_tokens ?? null,
          cache_read_tokens: s.cache_read_tokens ?? null,
          output_tokens: s.output_tokens ?? null,
          content: s.content || "",
          thinking: s.thinking || "",
          tool_calls: s.tool_calls || null,
          truncated_fields: s.truncated_fields || null,
        });
      } catch (_) {}
    }
    return { file: targetPath, steps };
  } catch (e) {
    return { file: null, steps: [], error: e.message };
  }
}

function readSessionTokenStats(sessionId) {
  const stats = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0 };
  if (!sessionId) return stats;
  try {
    const p = path.join(
      os.homedir(),
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );
    if (!fs.existsSync(p)) return stats;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line);
        if (s.type === "PLANNER_RESPONSE") {
          stats.inputTokens += Number(s.input_tokens || 0);
          stats.cacheReadTokens += Number(s.cache_read_tokens || 0);
          stats.outputTokens += Number(s.output_tokens || 0);
          stats.turns += 1;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return stats;
}

function normalizeQuotaPayload(rawJson, rawText) {
  const result = {
    tier: "",
    credits: null,
    groups: [],
    summaryText: "",
    raw: rawJson || rawText || "",
  };
  if (!rawJson || typeof rawJson !== "object") {
    result.summaryText = String(rawText || "").trim();
    return result;
  }

  // Locate command data across common agy --output-format json shapes
  const data =
    rawJson.command?.data ||
    rawJson.data ||
    rawJson.result?.data ||
    rawJson;

  result.tier = data.tier || data.plan || data.planName || rawJson.tier || "";
  if (data.credits !== undefined) result.credits = data.credits;
  else if (data.aiCredits !== undefined) result.credits = data.aiCredits;

  if (typeof rawJson.result === "string") result.summaryText = rawJson.result;
  else if (typeof rawJson.text === "string") result.summaryText = rawJson.text;
  else if (typeof rawJson.command?.message === "string") result.summaryText = rawJson.command.message;

  const rawGroups =
    data.groups ||
    data.modelGroups ||
    data.quotas ||
    data.buckets ||
    [];

  if (Array.isArray(rawGroups)) {
    for (const g of rawGroups) {
      if (!g || typeof g !== "object") continue;
      const buckets = Array.isArray(g.buckets)
        ? g.buckets
        : Array.isArray(g.windows)
          ? g.windows
          : [g];
      const normBuckets = buckets
        .filter((b) => b && typeof b === "object")
        .map((b) => {
          let pct = null;
          if (typeof b.remainingFraction === "number") pct = Math.round(b.remainingFraction * 100);
          else if (typeof b.remaining_fraction === "number") pct = Math.round(b.remaining_fraction * 100);
          else if (typeof b.remainingPercent === "number") pct = Math.round(b.remainingPercent);
          else if (typeof b.remaining_percent === "number") pct = Math.round(b.remaining_percent);
          else if (typeof b.usedFraction === "number") pct = Math.round((1 - b.usedFraction) * 100);
          else if (typeof b.usedPercent === "number") pct = Math.round(100 - b.usedPercent);
          if (pct !== null) pct = Math.max(0, Math.min(100, pct));

          return {
            window: b.window || b.label || b.name || b.period || "配额窗口",
            remainingPercent: pct,
            resetTime: b.resetTime || b.reset_time || b.resetAt || b.reset_at || b.resetAfter || "",
            detail: b.detail || b.status || "",
          };
        });

      result.groups.push({
        name: g.name || g.label || g.groupName || g.modelGroup || g.model || "模型分组",
        models: Array.isArray(g.models) ? g.models : [],
        buckets: normBuckets,
      });
    }
  }

  return result;
}

function queryCliQuota(cwd) {
  return new Promise((resolve) => {
    const proc = spawn("agy", ["--print", "/usage", "--output-format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: cwd || process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch (_) {}
      resolve({ ok: false, error: "查询额度超时（18秒），请稍后重试。" });
    }, 18000);

    proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: "无法执行 agy 命令: " + err.message });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let parsed = null;
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed);
        } catch (_) {
          // Try extracting last JSON object line if logs preceded it
          const lines = trimmed.split(/\r?\n/).reverse();
          for (const l of lines) {
            if (l.trim().startsWith("{")) {
              try { parsed = JSON.parse(l.trim()); break; } catch (_) {}
            }
          }
        }
      }
      if (code !== 0 && !parsed) {
        resolve({
          ok: false,
          error: (stderr || trimmed || `agy /usage 返回错误码 ${code}`).trim().slice(0, 600),
        });
        return;
      }
      resolve({
        ok: true,
        fetchedAt: new Date().toISOString(),
        quota: normalizeQuotaPayload(parsed, trimmed),
      });
    });
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function serveStatic(res, reqPath) {
  const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const mime =
    {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    }[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  // SSE event stream
  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    bridge.sseClients.add(res);
    res.write(`event: sessions_status\ndata: ${JSON.stringify({ statuses: bridge.getRuntimeStatuses() })}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (_) {
        clearInterval(keepAlive);
      }
    }, 20000);

    req.on("close", () => {
      clearInterval(keepAlive);
      bridge.sseClients.delete(res);
    });
    return;
  }

  // API endpoints
  if (pathname.startsWith("/api/")) {
    try {
      if (req.method === "GET" && pathname === "/api/state") {
        await bridge.ensureStarted();
        const reqSid = url.searchParams.get("sessionId");
        if (reqSid && bridge.sessions.has(reqSid)) {
          const s = bridge.sessions.get(reqSid);
          s.unreadDone = false;
          if (!s.busy) bridge.syncFromLocalTranscript(s);
          return sendJson(res, 200, bridge.getSnapshot(reqSid));
        }
        if (reqSid) {
          try {
            const snap = await bridge.loadSession(reqSid, bridge.defaultCwd);
            return sendJson(res, 200, snap);
          } catch (_) {}
        }
        if (!bridge.defaultSessionId || !bridge.sessions.has(bridge.defaultSessionId)) {
          await bridge.newSession(bridge.defaultCwd);
        } else {
          const s = bridge.sessions.get(bridge.defaultSessionId);
          if (!s.busy) bridge.syncFromLocalTranscript(s);
        }
        return sendJson(res, 200, bridge.getSnapshot(bridge.defaultSessionId));
      }

      if (req.method === "POST" && pathname === "/api/session/sync") {
        await bridge.ensureStarted();
        const body = await readJsonBody(req);
        const sess = bridge.getSession(body.sessionId);
        if (sess && !sess.busy) bridge.syncFromLocalTranscript(sess, !!body.force);
        return sendJson(res, 200, bridge.getSnapshot(sess?.sessionId));
      }

      if (req.method === "GET" && pathname === "/api/sessions") {
        const cwd = url.searchParams.get("cwd") || bridge.cwd;
        const result = await bridge.listSessions(cwd);
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && pathname === "/api/quota") {
        const sid = url.searchParams.get("sessionId") || bridge.defaultSessionId;
        const sess = bridge.getSession(sid);
        const targetCwd = sess ? sess.cwd : bridge.cwd;
        const [cliRes] = await Promise.all([queryCliQuota(targetCwd)]);
        const sessionStats = readSessionTokenStats(sid);
        return sendJson(res, 200, {
          ...cliRes,
          sessionUsage: sess ? sess.usage : { used: 0, size: 1048576 },
          sessionStats,
          currentModelId: sess ? sess.currentModelId : "",
        });
      }

      if (req.method === "GET" && pathname === "/api/inspector") {
        const sid = url.searchParams.get("sessionId") || bridge.defaultSessionId;
        const sess = bridge.getSession(sid);
        const targetCwd = sess ? sess.cwd : bridge.cwd;
        const rawData = readRawTranscriptSteps(sid);
        const customizations = readEffectiveCustomizations(targetCwd);
        return sendJson(res, 200, {
          sessionId: sid,
          transcriptFile: rawData.file,
          steps: rawData.steps,
          rpcLog: bridge.rpcLog.slice().reverse(),
          customizations,
        });
      }

      if (req.method === "GET" && pathname === "/api/files") {
        const sid = url.searchParams.get("sessionId");
        const sess = bridge.getSession(sid);
        const targetCwd = sess ? sess.cwd : bridge.cwd;
        const q = url.searchParams.get("q") || "";
        const files = scanWorkspaceFiles(targetCwd, q);
        return sendJson(res, 200, { cwd: targetCwd, files });
      }

      if (req.method === "GET" && pathname === "/api/diff") {
        const sid = url.searchParams.get("sessionId");
        const sess = bridge.getSession(sid);
        const targetCwd = sess ? sess.cwd : bridge.cwd;
        const diffData = await getWorkspaceDiff(targetCwd, sess ? sess.items : []);
        return sendJson(res, 200, diffData);
      }

      if (req.method === "GET" && pathname === "/api/snippets") {
        return sendJson(res, 200, { snippets: loadSnippets() });
      }

      if (req.method === "POST" && pathname === "/api/snippets") {
        const body = await readJsonBody(req);
        const saved = saveSnippets(body.snippets || []);
        return sendJson(res, 200, { snippets: saved });
      }

      if (req.method === "POST" && pathname === "/api/rules/save") {
        const body = await readJsonBody(req);
        const sess = bridge.getSession(body.sessionId);
        const targetCwd = sess ? sess.cwd : bridge.cwd;
        const result = saveRuleFile(targetCwd, body.path, body.content);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/translate") {
        const body = await readJsonBody(req);
        const result = await translateThoughtToZh(body.text || "");
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === "POST" && pathname === "/api/session/new") {
        const body = await readJsonBody(req);
        const snap = await bridge.newSession(body.cwd);
        return sendJson(res, 200, snap);
      }

      if (req.method === "POST" && pathname === "/api/session/load") {
        const body = await readJsonBody(req);
        if (!body.sessionId) return sendJson(res, 400, { error: "缺少 sessionId" });
        const snap = await bridge.loadSession(body.sessionId, body.cwd);
        return sendJson(res, 200, snap);
      }

      if (req.method === "POST" && pathname === "/api/session/rename") {
        const body = await readJsonBody(req);
        const result = bridge.renameSession(body.sessionId, body.title);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/session/hide") {
        const body = await readJsonBody(req);
        const result = bridge.setSessionHidden(body.sessionId, !!body.hidden);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/session/delete") {
        const body = await readJsonBody(req);
        const result = await bridge.deleteSessionPermanently(body.sessionId, body.activeSessionId);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/model") {
        const body = await readJsonBody(req);
        if (!body.modelId) return sendJson(res, 400, { error: "缺少 modelId" });
        const result = await bridge.setModel(body.sessionId, body.modelId);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/mode") {
        const body = await readJsonBody(req);
        if (!body.modeId) return sendJson(res, 400, { error: "缺少 modeId" });
        const result = await bridge.setMode(body.sessionId, body.modeId);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/sandbox") {
        const body = await readJsonBody(req);
        const result = await bridge.setSandbox(!!body.enabled, body.sessionId);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/prompt") {
        const body = await readJsonBody(req);
        const result = await bridge.sendPrompt(body.sessionId, body.text || "", body.images || []);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/cancel") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, bridge.cancelTurn(body.sessionId));
      }

      if (req.method === "POST" && pathname === "/api/permission") {
        const body = await readJsonBody(req);
        const result = bridge.respondPermission(body.sessionId, body.rpcId, body.optionId);
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: "未知接口" });
    } catch (e) {
      return sendJson(res, 500, { error: e.message || String(e) });
    }
  }

  serveStatic(res, pathname);
});

const cliArgs = process.argv.slice(2);
const AUTO_OPEN = cliArgs.includes("--open");
function getArgVal(flag) {
  const idx = cliArgs.indexOf(flag);
  return idx >= 0 && cliArgs[idx + 1] ? cliArgs[idx + 1] : null;
}

const cliCwd = getArgVal("--cwd");
if (cliCwd) {
  bridge.cwd = normalizeCwd(cliCwd);
}

if (cliArgs.includes("--sandbox") || process.env.AGY_SANDBOX === "1") {
  bridge.sandbox = true;
} else if (cliArgs.includes("--no-sandbox")) {
  bridge.sandbox = false;
}

const cliMode = getArgVal("--mode");
if (cliMode) {
  bridge.prefs.defaultMode = cliMode.trim();
}

const startPort = parseInt(getArgVal("--port") || String(PORT), 10);

function openBrowser(urlStr) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", urlStr], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [urlStr], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [urlStr], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (_) {}
}

function listenWithFallback(port, retries = 20) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && retries > 0) {
      listenWithFallback(port + 1, retries - 1);
    } else {
      console.error("启动失败:", err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const actualPort = server.address().port;
    const urlStr = `http://${HOST}:${actualPort}`;
    console.log(`\n  Antigravity CLI Web 外壳已启动`);
    console.log(`  访问地址: ${urlStr}`);
    console.log(`  工作目录: ${bridge.cwd}`);
    console.log(`  终端沙箱: ${bridge.sandbox ? "已开启 (--sandbox)" : "未开启 (可在网页顶栏随时切换)"}`);
    if (bridge.prefs.defaultMode) {
      console.log(`  默认模式: ${bridge.prefs.defaultMode}`);
    }
    console.log(`  按 Ctrl+C 停止服务\n`);
    if (AUTO_OPEN) openBrowser(urlStr);
  });
}

listenWithFallback(startPort);

process.on("SIGINT", () => {
  bridge.shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  bridge.shutdown();
  process.exit(0);
});
