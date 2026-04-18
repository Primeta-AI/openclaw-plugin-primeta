// HTTP+SSE route registered at /primeta. Accepts a POST with a user
// message from a standalone client (the openclaw-test page, a future
// Primeta desktop app, etc.) that can reach the OpenClaw gateway
// directly. Streams the agent's reply back in OpenAI delta format.

import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchTurn } from "./dispatch.js";

interface WebhookBody {
  text: string;
  senderId?: string;
  senderName?: string;
  accountId?: string;
  personality?: string;
}

export async function handlePrimetaWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  const body = await readJsonBody(req);
  if (!isValidBody(body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing text field" }));
    return true;
  }

  const senderId = body.senderId?.trim() || "desktop-user";
  const accountId = body.accountId?.trim() || "default";
  const finalBody = body.personality
    ? `${body.personality}\n\n--- USER MESSAGE ---\n${body.text}`
    : body.text;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  try {
    await dispatchTurn({
      body: finalBody,
      senderId,
      bridgeName: senderId,
      messageSid: `pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      accountId,
      senderName: body.senderName || "User",
      conversationLabel: "Primeta Desktop",
      deliver: (text) => {
        const chunk = { choices: [{ delta: { content: text }, index: 0 }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
    });

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[primeta] webhook handler error:", err);
    const message = (err as Error).message || "Internal error";
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    } else {
      const errorChunk = { choices: [{ delta: { content: `\n[Error: ${message}]` }, index: 0 }] };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
  return true;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function isValidBody(body: unknown): body is WebhookBody {
  if (!body || typeof body !== "object") return false;
  const text = (body as Record<string, unknown>).text;
  return typeof text === "string" && text.length > 0;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}
