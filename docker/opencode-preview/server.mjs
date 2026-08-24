import net from "node:net";

const defaultUpstreamHost = process.env.PREVIEW_UPSTREAM_HOST ?? "opencode-app";
const listenHost = process.env.PREVIEW_LISTEN_HOST ?? "0.0.0.0";

export function defaultRoutes() {
  return [
    {
      listen: Number(process.env.PREVIEW_LISTEN_PORT ?? "3000"),
      upstreamHost: defaultUpstreamHost,
      upstreamPort: Number(process.env.PREVIEW_UPSTREAM_PORT ?? "3000")
    },
    {
      listen: Number(process.env.PREVIEW_LISTEN_PORT_ALT ?? "3001"),
      upstreamHost: defaultUpstreamHost,
      upstreamPort: Number(process.env.PREVIEW_UPSTREAM_PORT_ALT ?? "3001")
    }
  ];
}

export function proxyConnection(client, upstreamHostName, upstreamPort) {
  const upstream = net.connect(upstreamPort, upstreamHostName);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  return upstream;
}

export function listenPreviewRoutes(bindings = defaultRoutes()) {
  return bindings.map((route) =>
    net
      .createServer((client) =>
        proxyConnection(client, route.upstreamHost, route.upstreamPort)
      )
      .listen(route.listen, listenHost)
  );
}

if (import.meta.main) {
  listenPreviewRoutes();
}
