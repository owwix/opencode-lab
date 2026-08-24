function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyTotals() {
  return {
    requests: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costByLane: { fast: 0, lab: 0, deep: 0 }
  };
}

function laneForModel(modelID) {
  const model = String(modelID ?? "").toLowerCase();
  if (model.includes("glm-4.7-flash")) return "fast";
  if (model.includes("gpt-oss-120b")) return "lab";
  if (model.includes("kimi-k2.7-code")) return "deep";
  return null;
}

function messageInfo(raw) {
  return raw?.info ?? raw;
}

function messageUsage(raw) {
  const message = messageInfo(raw);
  if (message?.role !== "assistant" || !message.tokens) return emptyTotals();
  const cost = number(message.cost);
  const lane = laneForModel(message.modelID);
  return {
    requests: 1,
    input: number(message.tokens.input),
    output: number(message.tokens.output),
    reasoning: number(message.tokens.reasoning),
    cacheRead: number(message.tokens.cache?.read),
    cacheWrite: number(message.tokens.cache?.write),
    cost,
    costByLane: {
      fast: lane === "fast" ? cost : 0,
      lab: lane === "lab" ? cost : 0,
      deep: lane === "deep" ? cost : 0
    }
  };
}

function mergeTotals(target, change, direction = 1) {
  for (const key of Object.keys(target)) {
    if (key === "costByLane") continue;
    target[key] += direction * number(change[key]);
  }
  for (const lane of Object.keys(target.costByLane)) {
    target.costByLane[lane] += direction * number(change.costByLane?.[lane]);
  }
}

function createEntry() {
  return {
    hydrated: false,
    sequence: 0,
    messages: new Map(),
    tools: new Map(),
    totals: emptyTotals(),
    latestAssistant: null,
    latestUser: null,
    toolRevision: 0,
    toolListRevision: -1,
    toolList: [],
    qualityKey: null,
    qualityValue: null
  };
}

function resetEntry(entry) {
  entry.hydrated = false;
  entry.sequence = 0;
  entry.messages.clear();
  entry.tools.clear();
  entry.totals = emptyTotals();
  entry.latestAssistant = null;
  entry.latestUser = null;
  entry.toolRevision += 1;
  entry.toolListRevision = -1;
  entry.toolList = [];
  entry.qualityKey = null;
  entry.qualityValue = null;
}

function refreshLatest(entry, role) {
  let latest = null;
  for (const record of entry.messages.values()) {
    if (record.info?.role !== role) continue;
    if (!latest || record.order > latest.order) latest = record;
  }
  if (role === "assistant") entry.latestAssistant = latest?.info ?? null;
  else entry.latestUser = latest?.info ?? null;
}

function upsertMessage(entry, raw) {
  const info = messageInfo(raw);
  const id = info?.id;
  if (!id || !info?.sessionID) return false;
  const previous = entry.messages.get(id);
  if (previous) mergeTotals(entry.totals, messageUsage(previous.info), -1);
  const record = {
    info,
    order: previous?.order ?? ++entry.sequence
  };
  entry.messages.set(id, record);
  mergeTotals(entry.totals, messageUsage(info));
  if (info.role === "assistant") {
    if (
      !entry.latestAssistant ||
      entry.messages.get(entry.latestAssistant.id)?.order <= record.order
    ) {
      entry.latestAssistant = info;
    }
  } else if (info.role === "user") {
    if (
      !entry.latestUser ||
      entry.messages.get(entry.latestUser.id)?.order <= record.order
    ) {
      entry.latestUser = info;
    }
  }
  entry.qualityKey = null;
  return true;
}

function removeMessage(entry, messageID) {
  const previous = entry.messages.get(messageID);
  if (!previous) return false;
  mergeTotals(entry.totals, messageUsage(previous.info), -1);
  entry.messages.delete(messageID);
  if (entry.latestAssistant?.id === messageID)
    refreshLatest(entry, "assistant");
  if (entry.latestUser?.id === messageID) refreshLatest(entry, "user");
  let removedTool = false;
  for (const [id, part] of entry.tools) {
    if (part?.messageID !== messageID) continue;
    entry.tools.delete(id);
    removedTool = true;
  }
  if (removedTool) entry.toolRevision += 1;
  entry.qualityKey = null;
  return true;
}

function upsertTool(entry, part) {
  if (part?.type !== "tool" || !part.id) return false;
  entry.tools.set(part.id, part);
  entry.toolRevision += 1;
  entry.qualityKey = null;
  return true;
}

function removeTool(entry, partID) {
  if (!entry.tools.delete(partID)) return false;
  entry.toolRevision += 1;
  entry.qualityKey = null;
  return true;
}

function toolList(entry) {
  if (entry.toolListRevision !== entry.toolRevision) {
    entry.toolList = [...entry.tools.values()];
    entry.toolListRevision = entry.toolRevision;
  }
  return entry.toolList;
}

function eventProperties(event) {
  return event?.properties ?? event?.data ?? {};
}

export function eventSessionID(event) {
  const properties = eventProperties(event);
  return (
    properties.sessionID ??
    properties.info?.sessionID ??
    properties.part?.sessionID ??
    null
  );
}

export function createSessionViewCache() {
  const sessions = new Map();

  function entryFor(sessionID) {
    let entry = sessions.get(sessionID);
    if (!entry) {
      entry = createEntry();
      sessions.set(sessionID, entry);
    }
    return entry;
  }

  function hydrate(api, sessionID, entry) {
    if (entry.hydrated) return;
    resetEntry(entry);
    const messages = [...api.state.session.messages(sessionID)];
    for (const raw of messages) upsertMessage(entry, raw);
    for (const raw of messages) {
      const info = messageInfo(raw);
      if (!info?.id) continue;
      for (const part of api.state.part(info.id)) upsertTool(entry, part);
    }
    entry.hydrated = true;
  }

  function get(api, sessionID) {
    const entry = entryFor(sessionID);
    hydrate(api, sessionID, entry);
    return {
      totals: entry.totals,
      latestAssistant: entry.latestAssistant,
      latestUser: entry.latestUser,
      toolParts: toolList(entry)
    };
  }

  function recentMessages(api, sessionID) {
    const view = get(api, sessionID);
    return [view.latestUser, view.latestAssistant].filter(Boolean);
  }

  function quality(api, sessionID, buildSnapshot) {
    const entry = entryFor(sessionID);
    const view = get(api, sessionID);
    const status = api.state.session.status(sessionID);
    const pendingPermissions = api.state.session.permission(sessionID);
    const todos = api.state.session.todo(sessionID);
    const key = [
      entry.toolRevision,
      view.latestAssistant?.id ?? "",
      view.latestAssistant?.error ? "error" : "ok",
      status?.type ?? "idle",
      pendingPermissions.length,
      todos.map((todo) => todo.status).join(",")
    ].join("|");
    if (entry.qualityKey === key) return entry.qualityValue;
    entry.qualityValue = buildSnapshot({
      status,
      pendingPermissions,
      todos,
      messages: view.latestAssistant ? [view.latestAssistant] : [],
      parts: view.toolParts
    });
    entry.qualityKey = key;
    return entry.qualityValue;
  }

  function applyEvent(event) {
    const properties = eventProperties(event);
    const sessionID = eventSessionID(event);
    if (event?.type === "server.connected") {
      sessions.clear();
      return { changed: true, sessionID: null };
    }
    if (!sessionID) return { changed: false, sessionID: null };
    if (["session.compacted", "session.deleted"].includes(event.type)) {
      sessions.delete(sessionID);
      return { changed: true, sessionID };
    }
    const entry = entryFor(sessionID);
    let changed = false;
    if (event.type === "message.updated") {
      changed = upsertMessage(entry, properties.info);
    } else if (event.type === "message.removed") {
      changed = removeMessage(entry, properties.messageID);
    } else if (event.type === "message.part.updated") {
      changed = upsertTool(entry, properties.part);
    } else if (event.type === "message.part.removed") {
      changed = removeTool(entry, properties.partID);
    }
    return { changed, sessionID };
  }

  return {
    get,
    recentMessages,
    quality,
    applyEvent,
    invalidate(sessionID) {
      sessions.delete(sessionID);
    },
    clear() {
      sessions.clear();
    }
  };
}

export function subscribeSessionCache(
  api,
  cache,
  { includeToolParts = false, onEvent = () => {} } = {}
) {
  const subscriptions = [];
  const subscribe = (type) => {
    subscriptions.push(
      api.event.on(type, (event) => {
        const change = cache.applyEvent(event);
        onEvent(event, change);
      })
    );
  };
  subscribe("message.updated");
  subscribe("message.removed");
  subscribe("session.compacted");
  subscribe("session.deleted");
  subscribe("server.connected");
  if (includeToolParts) {
    subscribe("message.part.updated");
    subscribe("message.part.removed");
  }
  return () => {
    for (const unsubscribe of subscriptions.reverse()) unsubscribe();
  };
}

export function createDebouncedTask(task, delayMs) {
  let timeout;
  return {
    trigger() {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timeout = undefined;
        void task();
      }, delayMs);
    },
    cancel() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    }
  };
}
