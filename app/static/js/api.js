/**
 * Typed fetch wrapper for the SwarmWright API.
 * All functions return parsed JSON or throw {code, message} errors.
 */

const BASE = "/api/v1";

async function _req(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) {
    const err = json?.error || { code: "http_error", message: `HTTP ${res.status}` };
    throw err;
  }
  return json;
}

const get  = (path)         => _req("GET",    path);
const post = (path, body)   => _req("POST",   path, body);
const put  = (path, body)   => _req("PUT",    path, body);
const patch = (path, body)  => _req("PATCH",  path, body);
const del  = (path)         => _req("DELETE", path);

// ── Workspaces ───────────────────────────────────────────────────────────────
export const listWorkspaces    = ()     => get("/workspaces");
export const getWorkspace      = (id)   => get(`/workspaces/${id}`);
export const createWorkspace   = (body) => post("/workspaces", body);
export const updateWorkspace   = (id, body) => put(`/workspaces/${id}`, body);
export const deleteWorkspace   = (id)   => del(`/workspaces/${id}`);

// ── Swarms ───────────────────────────────────────────────────────────────────
export const listSwarms   = (wid)       => get(`/workspaces/${wid}/swarms`);
export const getSwarm     = (id)        => get(`/swarms/${id}`);
export const createSwarm  = (wid, body) => post(`/workspaces/${wid}/swarms`, body);
export const updateSwarm  = (id, body)  => put(`/swarms/${id}`, body);
export const deleteSwarm  = (id)        => del(`/swarms/${id}`);
export const copySwarm    = (id, body)  => post(`/swarms/${id}/copy`, body);
export const moveSwarm    = (id, body)  => post(`/swarms/${id}/move`, body);
export const getHierarchy = (id)        => get(`/swarms/${id}/hierarchy`);
export const patchTopology = (id, op, params) => patch(`/swarms/${id}/topology`, { op, params });

// ── Agents ───────────────────────────────────────────────────────────────────
export const listAgents         = (sid)         => get(`/swarms/${sid}/agents`);
export const getAgent           = (id)          => get(`/agents/${id}`);
export const createAgent        = (sid, body)   => post(`/swarms/${sid}/agents`, body);
export const updateConstitution = (id, constitution) => put(`/agents/${id}/constitution`, { constitution });
export const deleteAgent        = (id)          => del(`/agents/${id}`);
export const getAgentHistory    = (id)          => get(`/agents/${id}/history`);
export const draftConstitution  = (id, prompt)  => post(`/agents/${id}/draft`, { prompt });

// ── Knowledge ────────────────────────────────────────────────────────────────
export const listKnowledge   = (params = {}) => get("/knowledge?" + new URLSearchParams(params));
export const getKnowledge    = (id)          => get(`/knowledge/${id}`);
export const createKnowledge = (body)        => post("/knowledge", body);
export const updateKnowledge = (id, body)    => put(`/knowledge/${id}`, body);
export const deleteKnowledge = (id)          => del(`/knowledge/${id}`);
export const draftKnowledge    = (id, prompt)  => post(`/knowledge/${id}/draft`, { prompt });
export const transferKnowledge = (id, body)    => post(`/knowledge/${id}/transfer`, body);
export const draftSkill        = (name, prompt) => post("/skills/_meta/draft", { name, prompt });

// ── Skills ───────────────────────────────────────────────────────────────────
export const listSkills = (params = {}) => get("/skills?" + new URLSearchParams(params));
export const getSkill   = (name, params = {}) => get(`/skills/${name}?` + new URLSearchParams(params));
export const createSkill = (body) => post("/skills", body);
export const updateSkill = (name, body) => put(`/skills/${name}`, body);
export const deleteSkill    = (name, params = {}) => del(`/skills/${name}?` + new URLSearchParams(params));
export const transferSkill  = (name, body) => post(`/skills/${name}/transfer`, body);
export const testSkill      = (name, params = {}, input = {}) => post(`/skills/${name}/test?` + new URLSearchParams(params), { input });
export const getSkillsRuntime = () => get("/skills/_meta/runtime");

// ── Runs ─────────────────────────────────────────────────────────────────────
export const listRuns    = (params = {}) => get("/runs?" + new URLSearchParams(params));
export const getRun      = (id)          => get(`/runs/${id}`);
export const replayRun   = (id)          => post(`/runs/${id}/replay`, {});
export const stopRun     = (id)          => post(`/runs/${id}/stop`, {});
export const getRunStats = ()            => get("/runs/stats");

// ── Events ───────────────────────────────────────────────────────────────────
export const fireEvent   = (sid, body)    => post(`/swarms/${sid}/events`, body);
export const listEvents  = (params = {})  => get("/events?" + new URLSearchParams(params));

// ── Triggers ─────────────────────────────────────────────────────────────────
export const listTriggers   = (sid)        => get(`/swarms/${sid}/triggers`);
export const createTrigger  = (sid, body)  => post(`/swarms/${sid}/triggers`, body);
export const updateTrigger  = (id, body)   => put(`/triggers/${id}`, body);
export const deleteTrigger  = (id)         => del(`/triggers/${id}`);
export const invokeTrigger  = (id, body)   => post(`/triggers/invocations/${id}`, body || {});

// ── Callers + Inbox (Phase 6) ────────────────────────────────────────────────
export const listCallers     = (params = {})    => get("/callers?" + new URLSearchParams(params));
export const getCaller       = (name, params = {}) => get(`/callers/${encodeURIComponent(name)}?` + new URLSearchParams(params));
export const createCaller    = (body)            => post("/callers", body);
export const updateCaller    = (name, body)      => put(`/callers/${encodeURIComponent(name)}`, body);
export const deleteCaller    = (name, params = {}) => del(`/callers/${encodeURIComponent(name)}?` + new URLSearchParams(params));
export const listInbox       = (params = {})    => get("/inbox?" + new URLSearchParams(params));
export const getInboxItem    = (id)              => get(`/inbox/${encodeURIComponent(id)}`);
export const decideInboxItem  = (id, body)       => post(`/inbox/${encodeURIComponent(id)}/decide`, body || {});

// ── Informers + Informs (Phase 6.1) ──────────────────────────────────────────
export const listInformers   = (params = {})    => get("/informers?" + new URLSearchParams(params));
export const getInformer     = (name, params = {}) => get(`/informers/${encodeURIComponent(name)}?` + new URLSearchParams(params));
export const createInformer  = (body)            => post("/informers", body);
export const updateInformer  = (name, body)      => put(`/informers/${encodeURIComponent(name)}`, body);
export const deleteInformer  = (name, params = {}) => del(`/informers/${encodeURIComponent(name)}?` + new URLSearchParams(params));
export const listInforms     = (params = {})    => get("/informs?" + new URLSearchParams(params));
export const getInformItem   = (id)              => get(`/informs/${encodeURIComponent(id)}`);
export const readInformItem  = (id, body)        => post(`/informs/${encodeURIComponent(id)}/read`,    body || {});
export const dismissInformItem = (id, body)      => post(`/informs/${encodeURIComponent(id)}/dismiss`, body || {});

// ── Swarm Files (Phase 7) ────────────────────────────────────────────────────
export const listAllFiles      = (params = {})      => get("/files?" + new URLSearchParams(params));
export const listSwarmFiles    = (sid, params = {}) => get(`/swarms/${sid}/files?` + new URLSearchParams(params));
export const deleteSwarmFile   = (sid, path)        => del(`/swarms/${sid}/files?path=${encodeURIComponent(path)}`);
export const downloadSwarmFileUrl = (sid, path)     => `/api/v1/swarms/${sid}/files/download?path=${encodeURIComponent(path)}`;
export const rawSwarmFileUrl   = (sid, path)        => `/api/v1/swarms/${sid}/files/raw?path=${encodeURIComponent(path)}`;
export const linkSwarmFile     = (sid, body)        => post(`/swarms/${sid}/files/link`, body);

export async function uploadSwarmFile(swarmId, file, path, overwrite = false) {
  const form = new FormData();
  form.append("file", file);
  if (path) form.append("path", path);
  const url = `/api/v1/swarms/${swarmId}/files` + (overwrite ? "?overwrite=true" : "");
  const res = await fetch(url, { method: "POST", body: form });
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) throw json?.error || { code: "http_error", message: `HTTP ${res.status}` };
  return json;
}

// ── Settings (Phase 5) ───────────────────────────────────────────────────────
export const listSettings       = ()              => get("/settings");
export const getSetting         = (key)           => get(`/settings/${encodeURIComponent(key)}`);
export const putSetting         = (key, body)     => put(`/settings/${encodeURIComponent(key)}`, body);
export const bulkPutSettings    = (body)          => put("/settings", body);
export const getSettingsAudit   = (params = {})   => get("/settings/audit?" + new URLSearchParams(params));
export const testLlmConnection  = (body)          => post("/settings/llm/test", body);
export const rotateMasterKey    = (body)          => post("/settings/security/rotate-key", body || {});
export const checkPackageInstalled = (name)       => get(`/settings/system/packages/check?name=${encodeURIComponent(name)}`);
export const installPackage        = (name)       => post("/settings/system/packages/install", { name });

export const deleteLogo = () => _req("DELETE", "/settings/branding/logo");

export async function uploadLogo(file) {
  // Multipart form upload — bypasses the JSON `_req` helper.
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(BASE + "/settings/branding/logo", { method: "POST", body: fd });
  const json = await res.json();
  if (!res.ok) throw json?.error || { code: "http_error", message: `HTTP ${res.status}` };
  return json;
}

// ── Users ─────────────────────────────────────────────────────────────────────
export const listUsers   = ()          => get("/users");
export const getUser     = (id)        => get(`/users/${id}`);
export const createUser  = (body)      => post("/users", body);
export const updateUser  = (id, body)  => put(`/users/${id}`, body);
export const deleteUser  = (id)        => del(`/users/${id}`);

// ── Chat (Phase 8) ────────────────────────────────────────────────────────────
export const createOrGetChatSession = (body)         => post("/chat/sessions", body);
export const listChatSessions       = (params = {})  => get("/chat/sessions?" + new URLSearchParams(params));
export const listChatMessages       = (sid, params = {}) => get(`/chat/sessions/${sid}/messages?` + new URLSearchParams(params));
export const sendChatMessage        = (sid, content) => post(`/chat/sessions/${sid}/messages`, { content });
export const wipeChatMessages       = (sid)          => del(`/chat/sessions/${sid}/messages`);
export const deleteChatSession      = (sid)          => del(`/chat/sessions/${sid}`);
export const listUnmetNeeds         = (params = {})  => get("/unmet-needs?" + new URLSearchParams(params));
export const patchUnmetNeed         = (id, body)     => patch(`/unmet-needs/${id}`, body);
