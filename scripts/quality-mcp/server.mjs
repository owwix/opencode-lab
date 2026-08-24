import { createServer } from "node:http";
import { handleQualityMcp } from "./handler.mjs";
import {
  jsonRpcInternalError,
  toWebRequest,
  writeNodeResponse
} from "./http.mjs";

const host = "127.0.0.1";
const port = Number(process.env.QUALITY_MCP_PORT || 8793);
const token = process.env.QUALITY_MCP_TOKEN?.trim();

if (!token) {
  console.error("QUALITY_MCP_TOKEN is required.");
  process.exit(1);
}

const server = createServer(async (request, response) => {
  try {
    const webRequest = await toWebRequest(request, host, port);
    const webResponse = await handleQualityMcp(webRequest, token);
    await writeNodeResponse(response, webResponse);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(jsonRpcInternalError());
    console.error(error);
  }
});

server.listen(port, host, () => {
  console.log(
    `Quality MCP listening on http://${host}:${port}/mcp (loopback only)`
  );
});
