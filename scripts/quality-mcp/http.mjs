export async function toWebRequest(request, host, port) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = request.method ?? "GET";
  return new Request(`http://${host}:${port}${request.url}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body
  });
}

export async function writeNodeResponse(response, webResponse) {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  if (!webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) response.write(Buffer.from(value));
    }
    response.end();
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined);
  }
}

export function jsonRpcInternalError() {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: null
  });
}
