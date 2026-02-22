import { createServer } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { whatsappPlugin } from "./src/channel.js";
import { getWhatsAppRuntime, setWhatsAppRuntime } from "./src/runtime.js";

/**
 * Minimal bridge send server.
 * When BRIDGE_SEND_PORT is set, binds localhost:<port> and accepts:
 *   POST /send  { to: string, text: string, accountId?: string }
 * Protected by x-bridge-secret header (matches BRIDGE_SECRET env var).
 * This lets the clawos/bridge process send WhatsApp replies through the
 * existing Baileys session without starting a second connection.
 */
function startBridgeSendServer(port: number, secret: string | undefined): void {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/send") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (secret && req.headers["x-bridge-secret"] !== secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            to?: string;
            text?: string;
            accountId?: string;
          };
          if (!body.to || !body.text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing to or text" }));
            return;
          }
          await getWhatsAppRuntime().channel.whatsapp.sendMessageWhatsApp(body.to, body.text, {
            verbose: false,
            accountId: body.accountId ?? undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      })();
    });
    req.on("error", () => {
      res.writeHead(500);
      res.end();
    });
  });

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`[clawos-bridge-send] listening on localhost:${port}\n`);
  });
  server.on("error", (err: Error) => {
    process.stderr.write(`[clawos-bridge-send] error: ${err.message}\n`);
  });
}

const plugin = {
  id: "whatsapp",
  name: "WhatsApp",
  description: "WhatsApp channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWhatsAppRuntime(api.runtime);
    api.registerChannel({ plugin: whatsappPlugin });

    // Start the bridge send server when configured.
    const sendPortStr = process.env.BRIDGE_SEND_PORT;
    if (sendPortStr) {
      startBridgeSendServer(Number(sendPortStr), process.env.BRIDGE_SECRET);
    }
  },
};

export default plugin;
