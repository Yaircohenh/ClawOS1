export function validateActionRequest(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "body must be an object" };
  }

  const {
    request_id,
    workspace_id,
    agent_id,
    action_type,
    destination,
    payload,
    meta,
    scopes,
    approval_token,
  } = input;

  // required
  for (const [k, v] of [
    ["workspace_id", workspace_id],
    ["agent_id", agent_id],
    ["action_type", action_type],
  ]) {
    if (typeof v !== "string" || !v.trim()) {
      return { ok: false, error: `${k} must be a non-empty string` };
    }
  }

  // optional
  if (request_id != null && typeof request_id !== "string") {
    return { ok: false, error: "request_id must be string if provided" };
  }
  if (destination != null && typeof destination !== "string") {
    return { ok: false, error: "destination must be string if provided" };
  }
  if (payload != null && typeof payload !== "object") {
    return { ok: false, error: "payload must be object if provided" };
  }
  if (meta != null && typeof meta !== "object") {
    return { ok: false, error: "meta must be object if provided" };
  }
  if (scopes != null && !Array.isArray(scopes)) {
    return { ok: false, error: "scopes must be array if provided" };
  }
  if (approval_token != null && typeof approval_token !== "string") {
    return { ok: false, error: "approval_token must be string if provided" };
  }

  return {
    ok: true,
    value: {
      request_id: request_id || `req_${Date.now()}`,
      workspace_id,
      agent_id,
      action_type,
      destination: destination || "",
      payload: payload || {},
      meta: meta || {},
      scopes: scopes || [],
      approval_token: approval_token || "",
    },
  };
}
