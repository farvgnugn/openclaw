import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway.ts";
import { generateUUID } from "../uuid.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Project = {
  id: string;
  name: string;
  description?: string;
  stack?: string[];
  status?: string;
  lastCommit?: { hash: string; message: string };
  githubUrl?: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  ts: number;
};

export type ProjectsProps = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  onRequestUpdate: () => void;
};

// ─── Module-level state ───────────────────────────────────────────────────────

let _projects: Project[] = [];
let _loading = false;
let _error: string | null = null;
let _selectedId: string | null = null;
let _busyIds = new Set<string>();
let _refreshTimer: ReturnType<typeof setInterval> | null = null;
let _iframePath: Record<string, string> = {};
let _chatOpen = true;
let _chatInputs: Record<string, string> = {};
let _chatThinking: Record<string, boolean> = {};
let _chatHistories: Record<string, ChatMessage[]> = {};
let _requestUpdate: (() => void) | null = null;
// Per-project session keys — each project gets its own isolated chat session
let _projectSessionKeys: Record<string, string> = {};

function update() {
  _requestUpdate?.();
}

function persistChat(projectId: string) {
  try {
    localStorage.setItem(
      `projects-chat-${projectId}`,
      JSON.stringify(_chatHistories[projectId] ?? []),
    );
  } catch {
    // ignore
  }
}

function loadChatFromStorage(projectId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`projects-chat-${projectId}`);
    if (raw) {
      return JSON.parse(raw) as ChatMessage[];
    }
  } catch {
    // ignore
  }
  return [];
}

// ─── Per-project session management ──────────────────────────────────────────

const PROJECT_SESSION_STORAGE_KEY = "projects-session-keys";

function loadProjectSessionKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PROJECT_SESSION_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    // ignore
  }
  return {};
}

function saveProjectSessionKeys() {
  try {
    localStorage.setItem(PROJECT_SESSION_STORAGE_KEY, JSON.stringify(_projectSessionKeys));
  } catch {
    // ignore
  }
}

async function getOrCreateProjectSession(
  client: GatewayBrowserClient,
  projectId: string,
  projectName: string,
): Promise<string> {
  // Return cached session key if it exists
  if (_projectSessionKeys[projectId]) {
    return _projectSessionKeys[projectId];
  }

  // Try to create a new named session for this project
  try {
    const result = await client.request<{ sessionKey?: string; key?: string }>("sessions.create", {
      label: `project:${projectId}`,
      agentId: "main",
      context: `You are a coding assistant for the ${projectName} project. Answer questions about its codebase, architecture, and help debug issues.`,
    });
    const key = result.sessionKey ?? result.key;
    if (key) {
      _projectSessionKeys[projectId] = key;
      saveProjectSessionKeys();
      return key;
    }
  } catch {
    // sessions.create not supported — fall back to a stable derived key
  }

  // Fallback: use a stable localStorage-persisted key derived from projectId
  const fallbackKey = `project-session-${projectId}`;
  _projectSessionKeys[projectId] = fallbackKey;
  saveProjectSessionKeys();
  return fallbackKey;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (Array.isArray(data)) {
    return data as Project[];
  }
  if (data && typeof data === "object" && "projects" in data) {
    return (data as { projects: Project[] }).projects;
  }
  return [];
}

async function loadProjects() {
  _loading = true;
  _error = null;
  update();
  try {
    _projects = await fetchProjects();
  } catch (err) {
    _error = String(err);
  } finally {
    _loading = false;
    update();
  }
}

async function startProject(id: string) {
  _busyIds.add(id);
  update();
  try {
    await fetch(`/api/projects/${id}/start`, { method: "POST" });
    await loadProjects();
  } catch (err) {
    _error = String(err);
  } finally {
    _busyIds.delete(id);
    update();
  }
}

async function stopProject(id: string) {
  _busyIds.add(id);
  update();
  try {
    await fetch(`/api/projects/${id}/stop`, { method: "POST" });
    await loadProjects();
  } catch (err) {
    _error = String(err);
  } finally {
    _busyIds.delete(id);
    update();
  }
}

function selectProject(id: string) {
  _selectedId = id;
  if (!_chatHistories[id]) {
    _chatHistories[id] = loadChatFromStorage(id);
  }
  if (!_iframePath[id]) {
    _iframePath[id] = "/";
  }
  update();
}

async function sendChat(
  client: GatewayBrowserClient | null,
  _mainSessionKey: string,
  projectId: string,
  message: string,
) {
  const project = _projects.find((p) => p.id === projectId);
  if (!project || !client) {
    return;
  }

  // Use a per-project session so chats don't bleed into the main channel
  const sessionKey = await getOrCreateProjectSession(client, projectId, project.name);

  const stack = project.stack ?? [];
  const path = _iframePath[projectId] ?? "/";
  const contextPrefix = `[Context: Viewing ${project.name} at ${path} | Stack: ${stack.join(", ")}]\n`;
  const fullMessage = contextPrefix + message;

  const userMsg: ChatMessage = { role: "user", text: message, ts: Date.now() };
  _chatHistories[projectId] = [...(_chatHistories[projectId] ?? []), userMsg];
  _chatInputs[projectId] = "";
  _chatThinking[projectId] = true;
  persistChat(projectId);
  update();

  const runId = generateUUID();
  try {
    await client.request("chat.send", {
      sessionKey,
      message: fullMessage,
      deliver: false,
      idempotencyKey: runId,
    });

    // Poll for response — listen via a short poll on chat history
    // Since we don't have access to the gateway event stream here,
    // we wait briefly then fetch history
    await new Promise((r) => setTimeout(r, 2000));
    const res = await client.request<{ messages?: unknown[] }>("chat.history", {
      sessionKey,
      limit: 5,
    });
    const messages = Array.isArray(res.messages) ? res.messages : [];
    // Find the latest assistant message
    const lastAssistant = [...messages]
      .toReversed()
      .find((m) => m && typeof m === "object" && (m as { role?: string }).role === "assistant");
    if (lastAssistant) {
      const content = (lastAssistant as { content?: unknown; text?: unknown }).content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((b) => (b && typeof b === "object" && (b as { text?: unknown }).text) || "")
          .join("");
      } else if (typeof (lastAssistant as { text?: unknown }).text === "string") {
        text = (lastAssistant as { text: string }).text;
      }
      if (text) {
        const assistantMsg: ChatMessage = { role: "assistant", text, ts: Date.now() };
        _chatHistories[projectId] = [...(_chatHistories[projectId] ?? []), assistantMsg];
        persistChat(projectId);
      }
    }
  } catch (err) {
    const errMsg: ChatMessage = {
      role: "assistant",
      text: `Error: ${String(err)}`,
      ts: Date.now(),
    };
    _chatHistories[projectId] = [...(_chatHistories[projectId] ?? []), errMsg];
    persistChat(projectId);
  } finally {
    _chatThinking[projectId] = false;
    update();
  }
}

async function scanCodebase(
  client: GatewayBrowserClient | null,
  _mainSessionKey: string,
  projectId: string,
) {
  const project = _projects.find((p) => p.id === projectId);
  if (!project || !client) {
    return;
  }

  // Use per-project session
  const sessionKey = await getOrCreateProjectSession(client, projectId, project.name);

  const msg = `[Context: Projects dashboard - code scan requested for ${project.name}]\nPlease scan the codebase and summarize the architecture so you can answer questions about it.`;
  const userMsg: ChatMessage = {
    role: "user",
    text: "Scan codebase",
    ts: Date.now(),
  };
  _chatHistories[projectId] = [...(_chatHistories[projectId] ?? []), userMsg];
  _chatThinking[projectId] = true;
  persistChat(projectId);
  update();

  const runId = generateUUID();
  try {
    await client.request("chat.send", {
      sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
    });
    await new Promise((r) => setTimeout(r, 3000));
    const res = await client.request<{ messages?: unknown[] }>("chat.history", {
      sessionKey,
      limit: 5,
    });
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const lastAssistant = [...messages]
      .toReversed()
      .find((m) => m && typeof m === "object" && (m as { role?: string }).role === "assistant");
    if (lastAssistant) {
      const content = (lastAssistant as { content?: unknown; text?: unknown }).content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((b) => (b && typeof b === "object" && (b as { text?: unknown }).text) || "")
          .join("");
      } else if (typeof (lastAssistant as { text?: unknown }).text === "string") {
        text = (lastAssistant as { text: string }).text;
      }
      if (text) {
        const assistantMsg: ChatMessage = { role: "assistant", text, ts: Date.now() };
        _chatHistories[projectId] = [...(_chatHistories[projectId] ?? []), assistantMsg];
        persistChat(projectId);
      }
    }
  } catch (err) {
    const errMsg: ChatMessage = {
      role: "assistant",
      text: `Error: ${String(err)}`,
      ts: Date.now(),
    };
    _chatHistories[projectId] = [...(_chatHistories[projectId] ?? []), errMsg];
    persistChat(projectId);
  } finally {
    _chatThinking[projectId] = false;
    update();
  }
}

function startAutoRefresh(onRequestUpdate: () => void) {
  if (_refreshTimer !== null) {
    return;
  }
  _refreshTimer = setInterval(() => {
    void loadProjects();
  }, 30_000);
  _requestUpdate = onRequestUpdate;
}

function stopAutoRefresh() {
  if (_refreshTimer !== null) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

export function renderProjects(props: ProjectsProps) {
  // Register update callback and start refresh timer
  _requestUpdate = props.onRequestUpdate;
  startAutoRefresh(props.onRequestUpdate);

  const selectedProject = _projects.find((p) => p.id === _selectedId) ?? null;
  const chatHistory = _selectedId ? (_chatHistories[_selectedId] ?? []) : [];
  const thinking = _selectedId ? (_chatThinking[_selectedId] ?? false) : false;
  const chatInput = _selectedId ? (_chatInputs[_selectedId] ?? "") : "";

  return html`
    <style>
      .projects-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 16px;
        margin-top: 16px;
      }

      .project-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
        cursor: pointer;
        transition: border-color 0.15s, box-shadow 0.15s;
      }

      .project-card:hover,
      .project-card.selected {
        border-color: var(--accent);
        box-shadow: 0 0 0 1px var(--accent-glow);
      }

      .project-card-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      .project-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        background: var(--muted);
      }

      .project-status-dot.running {
        background: var(--ok);
        box-shadow: 0 0 6px var(--ok);
      }

      .project-name {
        font-weight: 600;
        color: var(--text-strong);
        flex: 1;
      }

      .project-desc {
        color: var(--muted-foreground);
        font-size: 13px;
        margin-bottom: 10px;
        line-height: 1.4;
      }

      .project-stack {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 10px;
      }

      .stack-badge {
        background: var(--accent-subtle);
        color: var(--accent);
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 11px;
        font-weight: 500;
      }

      .project-commit {
        font-size: 12px;
        color: var(--muted);
        font-family: var(--font-mono, monospace);
        margin-bottom: 10px;
      }

      .project-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .projects-preview {
        margin-top: 24px;
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
        background: var(--card);
      }

      .preview-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-bottom: 1px solid var(--border);
        background: var(--bg-elevated);
      }

      .preview-toolbar-title {
        font-weight: 600;
        color: var(--text-strong);
        flex: 1;
      }

      .preview-body {
        display: flex;
        height: 600px;
      }

      .preview-iframe-wrap {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        background: #fff;
      }

      .preview-iframe-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: var(--bg-elevated);
        border-bottom: 1px solid var(--border);
      }

      .preview-url {
        flex: 1;
        font-size: 12px;
        color: var(--muted);
        font-family: var(--font-mono, monospace);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .preview-iframe {
        flex: 1;
        border: none;
        width: 100%;
      }

      .chat-drawer {
        width: 380px;
        flex-shrink: 0;
        border-left: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        background: var(--card);
      }

      .chat-drawer.hidden {
        display: none;
      }

      .chat-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        background: var(--bg-elevated);
      }

      .chat-header-title {
        flex: 1;
        font-weight: 600;
        font-size: 13px;
        color: var(--text-strong);
      }

      .chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .chat-msg {
        max-width: 90%;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .chat-msg.user {
        align-self: flex-end;
        background: var(--accent);
        color: white;
        border-bottom-right-radius: 2px;
      }

      .chat-msg.assistant {
        align-self: flex-start;
        background: var(--bg-elevated);
        color: var(--text);
        border-bottom-left-radius: 2px;
      }

      .chat-thinking {
        align-self: flex-start;
        color: var(--muted);
        font-size: 13px;
        font-style: italic;
        padding: 4px 0;
      }

      .chat-input-row {
        display: flex;
        gap: 6px;
        padding: 10px 12px;
        border-top: 1px solid var(--border);
        background: var(--bg-elevated);
      }

      .chat-input-row textarea {
        flex: 1;
        resize: none;
        background: var(--bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 7px 10px;
        font-size: 13px;
        font-family: inherit;
        line-height: 1.4;
        min-height: 36px;
        max-height: 120px;
      }

      .chat-input-row textarea:focus {
        outline: none;
        border-color: var(--accent);
      }

      .projects-empty {
        text-align: center;
        padding: 48px 24px;
        color: var(--muted);
      }
    </style>

    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Projects</div>
          <div class="card-sub">Manage and preview your local projects.</div>
        </div>
        <button class="btn" ?disabled=${_loading} @click=${() => void loadProjects()}>
          ${_loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${_error ? html`<div class="callout danger" style="margin-top:12px">${_error}</div>` : nothing}

      ${
        !_loading && _projects.length === 0
          ? html`
              <div class="projects-empty">
                <div>No projects found.</div>
                <div style="margin-top: 6px; font-size: 13px">
                  Configure projects via <code>/api/projects</code> on the gateway.
                </div>
              </div>
            `
          : html`
        <div class="projects-grid">
          ${_projects.map((project) => {
            const isRunning = project.status === "running";
            const isBusy = _busyIds.has(project.id);
            const isSelected = _selectedId === project.id;
            return html`
              <div
                class="project-card ${isSelected ? "selected" : ""}"
                @click=${() => selectProject(project.id)}
              >
                <div class="project-card-header">
                  <div class="project-status-dot ${isRunning ? "running" : ""}"></div>
                  <div class="project-name">${project.name}</div>
                  ${
                    project.githubUrl
                      ? html`<a
                          href=${project.githubUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          @click=${(e: Event) => e.stopPropagation()}
                          class="btn btn--sm"
                          title="View on GitHub"
                          style="padding:2px 6px;font-size:11px;"
                        >GH</a>`
                      : nothing
                  }
                </div>
                ${
                  project.description
                    ? html`<div class="project-desc">${project.description}</div>`
                    : nothing
                }
                ${
                  project.stack && project.stack.length > 0
                    ? html`<div class="project-stack">
                        ${project.stack.map((s) => html`<span class="stack-badge">${s}</span>`)}
                      </div>`
                    : nothing
                }
                ${
                  project.lastCommit
                    ? html`<div class="project-commit">
                        ${project.lastCommit.hash} — ${project.lastCommit.message}
                      </div>`
                    : nothing
                }
                <div class="project-actions" @click=${(e: Event) => e.stopPropagation()}>
                  <button
                    class="btn btn--sm ${isRunning ? "danger" : "primary"}"
                    ?disabled=${isBusy}
                    @click=${() =>
                      isRunning ? void stopProject(project.id) : void startProject(project.id)}
                  >
                    ${isBusy ? "…" : isRunning ? "Stop" : "Start"}
                  </button>
                  <button
                    class="btn btn--sm"
                    @click=${() => selectProject(project.id)}
                  >
                    ${isSelected ? "Selected ✓" : "Preview"}
                  </button>
                </div>
              </div>
            `;
          })}
        </div>
      `
      }
    </section>

    ${
      selectedProject
        ? html`
          <div class="projects-preview">
            <div class="preview-toolbar">
              <div class="preview-toolbar-title">${selectedProject.name}</div>
              <button
                class="btn btn--sm"
                @click=${() => {
                  _chatOpen = !_chatOpen;
                  update();
                }}
                title="${_chatOpen ? "Hide chat" : "Show chat"}"
              >
                ${_chatOpen ? "Hide Chat" : "Chat"}
              </button>
            </div>
            <div class="preview-body">
              <div class="preview-iframe-wrap">
                <div class="preview-iframe-toolbar">
                  <button
                    class="btn btn--sm"
                    @click=${() => {
                      const iframe = document.querySelector(
                        `.preview-iframe[data-project="${selectedProject.id}"]`,
                      );
                      if (iframe) {
                        iframe.src = `/proxy/${_selectedId ?? ""}/`;
                      }
                    }}
                    title="Reload"
                  >↺ Reload</button>
                  <div class="preview-url">/proxy/${selectedProject.id}${_iframePath[selectedProject.id] ?? "/"}</div>
                </div>
                <iframe
                  class="preview-iframe"
                  data-project=${selectedProject.id}
                  src="/proxy/${selectedProject.id}/"
                  @load=${(e: Event) => {
                    try {
                      const iframe = e.target as HTMLIFrameElement;
                      const path = iframe.contentWindow?.location?.pathname ?? "/";
                      _iframePath[selectedProject.id] = path;
                      update();
                    } catch {
                      // cross-origin: ignore
                    }
                  }}
                ></iframe>
              </div>
              <div class="chat-drawer ${_chatOpen ? "" : "hidden"}">
                <div class="chat-header">
                  <div class="chat-header-title">Chat</div>
                  <button
                    class="btn btn--sm"
                    title="Scan codebase"
                    ?disabled=${thinking || !props.connected}
                    @click=${() =>
                      void scanCodebase(props.client, props.sessionKey, selectedProject.id)}
                  >Scan</button>
                  <button
                    class="btn btn--sm"
                    title="Clear chat"
                    @click=${() => {
                      _chatHistories[selectedProject.id] = [];
                      persistChat(selectedProject.id);
                      update();
                    }}
                  >Clear</button>
                </div>
                <div class="chat-messages" id="projects-chat-messages-${selectedProject.id}">
                  ${
                    chatHistory.length === 0
                      ? html`<div class="muted" style="font-size:13px;padding:8px 0;">
                          Ask anything about ${selectedProject.name}…
                        </div>`
                      : chatHistory.map(
                          (msg) => html`
                            <div class="chat-msg ${msg.role}">${msg.text}</div>
                          `,
                        )
                  }
                  ${
                    thinking
                      ? html`
                          <div class="chat-thinking">Thinking…</div>
                        `
                      : nothing
                  }
                </div>
                <div class="chat-input-row">
                  <textarea
                    rows="2"
                    placeholder="Ask something…"
                    .value=${chatInput}
                    ?disabled=${thinking || !props.connected}
                    @input=${(e: Event) => {
                      _chatInputs[selectedProject.id] = (e.target as HTMLTextAreaElement).value;
                    }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        const msg = (_chatInputs[selectedProject.id] ?? "").trim();
                        if (msg && !thinking && props.connected) {
                          void sendChat(props.client, props.sessionKey, selectedProject.id, msg);
                        }
                      }
                    }}
                  ></textarea>
                  <button
                    class="btn primary"
                    ?disabled=${thinking || !chatInput.trim() || !props.connected}
                    @click=${() => {
                      const msg = (chatInput ?? "").trim();
                      if (msg) {
                        void sendChat(props.client, props.sessionKey, selectedProject.id, msg);
                      }
                    }}
                  >Send</button>
                </div>
              </div>
            </div>
          </div>
        `
        : nothing
    }
  `;
}

export function initProjects(onRequestUpdate: () => void) {
  _requestUpdate = onRequestUpdate;
  _projectSessionKeys = loadProjectSessionKeys();
  void loadProjects();
  startAutoRefresh(onRequestUpdate);
}

export function destroyProjects() {
  stopAutoRefresh();
}
