/**
 * OpenAPI generation.
 *
 * Generated from the capability descriptors and the error vocabulary rather
 * than hand-written, for the same reason the registry reference is: a
 * hand-maintained API document is wrong within two releases, and nobody finds
 * out until an integrator does.
 */
import type { Registry } from "../registry/registry.ts";
import type { CapabilityDescriptor } from "../capabilities/descriptors.ts";
import { HTTP_STATUS } from "./status.ts";
import type { Role } from "./principal.ts";

export interface OpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  readonly prefix?: string;
  readonly servers?: readonly string[];
  /** Included so an integrator can see which role grants what. */
  readonly roles?: Registry<Role>;
}

export function generateOpenApi(
  descriptors: Registry<CapabilityDescriptor>,
  options: OpenApiOptions = {},
): Record<string, unknown> {
  const prefix = options.prefix ?? "/v1";
  const paths: Record<string, unknown> = {};

  for (const capability of descriptors.list()) {
    paths[`${prefix}/${capability.key}`] = {
      post: {
        operationId: capability.key,
        summary: capability.label,
        description: describeCapability(capability, options.roles),
        tags: [capability.phase],
        parameters: [
          {
            name: "X-Goip-Tenant",
            in: "header",
            required: false,
            schema: { type: "string" },
            description:
              "Required only for a principal holding more than one tenant. A single-tenant principal has it resolved automatically, so there is no field to get wrong.",
          },
          {
            name: "X-Correlation-Id",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Flows into the decision and every audit record it produces.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description:
                  "Capability arguments. `actor` and `tenant` are ignored: both are taken from the authenticated principal.",
                additionalProperties: true,
              },
            },
          },
        },
        responses: responsesFor(capability),
        security: [{ apiKey: [] }, { bearer: [] }],
      },
    };
  }

  paths[`${prefix}/capabilities`] = {
    get: {
      operationId: "listCapabilities",
      summary: "List capabilities",
      responses: { "200": { description: "The capability surface of this deployment." } },
    },
  };
  paths[`${prefix}/health`] = {
    get: {
      operationId: "health",
      summary: "Integrity health",
      description: "200 when the ledger balances and the audit chain verifies. Not a liveness probe.",
      responses: { "200": { description: "Healthy." }, "503": { description: "Unhealthy." } },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "GOIP",
      version: options.version ?? "1.0.0",
      description:
        "Universal value-exchange platform. Every operation is one of a closed set of capabilities; " +
        "the surface does not grow with the number of offer types, because there is only one kind of record.",
    },
    ...(options.servers === undefined ? {} : { servers: options.servers.map((url) => ({ url })) }),
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "apikey",
          description: "`Authorization: ApiKey <id>.<secret>`. Keys are stored hashed.",
        },
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "`Authorization: Bearer <claims>.<hmac>`. One signature algorithm, fixed; not JWT.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: Object.keys(HTTP_STATUS) },
                message: { type: "string", description: "Human-readable. Not a stable interface; match on `code`." },
                details: { type: "object", additionalProperties: true },
                correlationId: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

function describeCapability(capability: CapabilityDescriptor, roles?: Registry<Role>): string {
  const lines = [capability.description ?? ""];

  if (capability.financial) {
    lines.push("", "**Commits value.** Rate-limited tightly, and audited on every invocation.");
  } else if (!capability.mutating) {
    lines.push("", "Read-only: changes nothing and may be called freely.");
  }

  if (roles) {
    const granting = roles
      .list()
      .filter((role) => role.capabilities.includes("*") || role.capabilities.includes(capability.key))
      .map((role) => role.key);
    if (granting.length > 0) lines.push("", `Granted by: ${granting.join(", ")}.`);
  }
  return lines.join("\n").trim();
}

function responsesFor(capability: CapabilityDescriptor): Record<string, unknown> {
  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  });

  const responses: Record<string, unknown> = {
    "200": {
      description:
        "The capability succeeded. A decision that applied nothing is also a 200: not qualifying is an answer, and it arrives with the checks that explain it.",
      content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
    },
    "400": errorResponse("Malformed request, unknown registry entry, or mismatched units."),
    "403": errorResponse("Not authenticated, not permitted, or blocked by risk."),
    "404": errorResponse("No such capability, or a referenced record does not exist."),
    "429": errorResponse("Rate limited. `Retry-After` is set."),
    "500": errorResponse("A condition could not be evaluated, or an internal failure."),
  };

  if (capability.mutating) {
    responses["409"] = errorResponse("Illegal state, insufficient funds, a consumed limit, or a conflict.");
    responses["422"] = errorResponse("Governance refused: policy violations are in `details`.");
  }
  return responses;
}
