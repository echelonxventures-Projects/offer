/**
 * HTTP adapter.
 *
 * Eighty lines over the gateway, on `node:http` alone - no Express, no Fastify.
 * That is the test of whether the gateway is genuinely transport-neutral: if it
 * needed a framework's middleware model, it was not.
 *
 * An Express or Fastify adapter is the same shape: read body, build `ApiRequest`,
 * call `gateway.handle`, write the response.
 *
 * TLS is opt-in through {@link HttpOptions.tls}. Termination in front of the
 * process is still fine and often better - a load balancer that centralises
 * certificates - but a process that must present its own certificate can now do
 * so without an nginx beside it.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { Gateway, ApiRequest } from "./gateway.ts";
import { serialise } from "./gateway.ts";
import type { Registry } from "../registry/registry.ts";
import type { CapabilityDescriptor } from "../capabilities/descriptors.ts";
import { decode } from "../kernel/codec.ts";

export interface HttpTlsOptions {
  /** Path or buffer of the private key, or a PKCS#8 PEM string. */
  readonly key: string | Buffer;
  /** Path or buffer of the certificate chain, or a PEM string. */
  readonly cert: string | Buffer;
  /** Optional CA bundle, for mutual TLS. */
  readonly ca?: string | Buffer;
}

export interface HttpOptions {
  readonly gateway: Gateway;
  readonly descriptors: Registry<CapabilityDescriptor>;
  /** Path prefix. Defaults to "/v1". */
  readonly prefix?: string;
  /** Maximum request body, in bytes. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Health probe. Returns 200 when it resolves true. */
  readonly health?: () => Promise<boolean>;
  /**
   * Present a certificate from this process rather than terminating TLS upstream.
   *
   * Without this the adapter is plaintext, which is safe behind a terminating
   * proxy and unsafe on a public interface. Supplying both a key and a cert is
   * the minimum; anything less is a configuration error, not a degraded mode.
   */
  readonly tls?: HttpTlsOptions;
}

const TENANT_HEADER = "x-goip-tenant";
const CORRELATION_HEADER = "x-correlation-id";

/**
 * Parse `Authorization: <scheme> <token>`.
 *
 * Scheme names are normalised to lower case; `ApiKey`, `apikey` and `APIKEY`
 * are the same scheme, and a caller should not have to guess.
 */
function readCredentials(header: string | undefined): { scheme?: string; token?: string } {
  if (!header) return {};
  const space = header.indexOf(" ");
  if (space < 0) return { scheme: "apikey", token: header };
  return { scheme: header.slice(0, space).toLowerCase(), token: header.slice(space + 1).trim() };
}

async function readBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    // Enforced while reading, not after: a limit checked at the end has already
    // let the whole body into memory.
    if (total > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};

  const parsed = decode(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function createHttpServer(options: HttpOptions): Server {
  const prefix = options.prefix ?? "/v1";
  const maxBody = options.maxBodyBytes ?? 1_048_576;
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void handle(request, response).catch(() => {
      // A failure here means the response could not be written at all.
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":{"code":"INVALID_REQUEST","message":"request could not be processed"}}');
    });
  };

  if (options.tls !== undefined) {
    if (options.tls.key === undefined || options.tls.cert === undefined) {
      throw new TypeError("tls requires both a key and a cert; partial TLS is not a mode");
    }
    const tlsOptions: HttpsServerOptions = {
      key: options.tls.key,
      cert: options.tls.cert,
      ...(options.tls.ca === undefined ? {} : { ca: options.tls.ca }),
    };
    // An HTTPS server to a caller; the same handler serves both, and the gateway
    // never sees which transport carried the request.
    return createSecureServer(tlsOptions, handler);
  }

  return createServer(handler);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");

    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const payload = serialise(body);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        // The platform never wants a capability response cached by anything.
        "cache-control": "no-store",
        ...headers,
      });
      response.end(payload);
    };

    if (request.method === "GET" && url.pathname === `${prefix}/health`) {
      const healthy = options.health ? await options.health() : true;
      send(healthy ? 200 : 503, { status: healthy ? "ok" : "unhealthy" });
      return;
    }

    if (request.method === "GET" && url.pathname === `${prefix}/capabilities`) {
      send(200, { capabilities: options.descriptors.list() });
      return;
    }

    if (request.method !== "POST" || !url.pathname.startsWith(`${prefix}/`)) {
      send(404, { error: { code: "NOT_FOUND", message: "no such route" } });
      return;
    }

    const capability = url.pathname.slice(prefix.length + 1);
    let payload: Record<string, unknown>;
    try {
      payload = await readBody(request, maxBody);
    } catch (error) {
      send(400, {
        error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : "bad request" },
      });
      return;
    }

    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    const tenant = header(TENANT_HEADER);
    const correlationId = header(CORRELATION_HEADER);

    const apiRequest: ApiRequest = {
      capability,
      payload,
      credentials: readCredentials(header("authorization")),
      // The socket address, not a forwarded header: an attacker controls
      // X-Forwarded-For, and a rate limit keyed on it defends nothing. A
      // deployment behind a trusted proxy substitutes its own source here.
      ...(request.socket.remoteAddress === undefined ? {} : { source: request.socket.remoteAddress }),
      ...(tenant === undefined ? {} : { tenant }),
      ...(correlationId === undefined ? {} : { correlationId }),
    };

    const result = await options.gateway.handle(apiRequest);
    send(result.status, result.body, result.headers);
  }
}
