import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Owner = "alice" | "bob";

export interface GoogleCall {
  method: string;
  path: string;
  /** Who owns the bearer token, or null if Google would not recognise it. */
  owner: Owner | null;
  token: string;
}

/**
 * A local stand-in for the Google REST APIs (Search Console, Analytics Admin and Data). It is NOT Google:
 * it only mimics the response shapes our clients parse. It knows which "Google account" owns each access token
 * and answers with data that names that account, so a test can tell whose credentials reached Google.
 * Both accounts own the same Search Console site and the same GA4 property id on purpose.
 */
export class FakeGoogle {
  /** access token -> account. The credential layer is tagged so tokens it issues are registered here. */
  readonly tokens = new Map<string, Owner>();
  readonly revoked = new Set<string>();
  readonly calls: GoogleCall[] = [];
  /** Force the next matching API calls to fail. `path` is matched as a substring. */
  fail: { path: string; status: number; body?: unknown; headers?: Record<string, string>; times?: number } | null = null;
  base = "";
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
  get clientOptions() {
    return {
      gsc: { baseUrl: `${this.base}/webmasters/v3` },
      ga4: { adminBaseUrl: `${this.base}/admin/v1beta`, dataBaseUrl: `${this.base}/data/v1beta` },
    };
  }
  callsFor(owner: Owner, pathPart = ""): GoogleCall[] {
    return this.calls.filter((c) => c.owner === owner && c.path.includes(pathPart));
  }
  reset(): void {
    this.calls.length = 0;
    this.fail = null;
    this.revoked.clear();
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const url = new URL(req.url ?? "/", this.base);
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const owner = this.revoked.has(token) ? null : (this.tokens.get(token) ?? null);
    this.calls.push({ method: req.method ?? "GET", path: decodeURIComponent(url.pathname), owner, token });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    if (!owner) return send(401, { error: { code: 401, status: "UNAUTHENTICATED", message: `rejected ${token}` } });
    if (this.fail && url.pathname.includes(this.fail.path) && (this.fail.times === undefined || this.fail.times > 0)) {
      if (this.fail.times !== undefined) this.fail.times--;
      return send(this.fail.status, this.fail.body ?? { error: { code: this.fail.status, message: `upstream said secret ${token}` } }, this.fail.headers);
    }

    const path = decodeURIComponent(url.pathname);
    const clicks = owner === "alice" ? 111 : 222;

    // --- Search Console
    if (path === "/webmasters/v3/sites") {
      return send(200, { siteEntry: [{ siteUrl: "sc-domain:shared.example", permissionLevel: "siteOwner" }, { siteUrl: `sc-domain:${owner}-only.example`, permissionLevel: "siteFullUser" }] });
    }
    const gsc = /^\/webmasters\/v3\/sites\/(.+)\/searchAnalytics\/query$/.exec(path);
    if (gsc) {
      const site = gsc[1]!;
      if (site !== "sc-domain:shared.example" && site !== `sc-domain:${owner}-only.example`) {
        return send(403, { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "forbidden" }] } });
      }
      const dims = (body.dimensions as string[] | undefined) ?? [];
      return send(200, { rows: [{ keys: dims.map((d) => `${owner}:${d}`), clicks, impressions: clicks * 10, ctr: 0.1, position: 3.2 }], responseAggregationType: "byProperty" });
    }

    // --- GA4
    if (path === "/admin/v1beta/accountSummaries") {
      return send(200, { accountSummaries: [{ account: `accounts/${owner === "alice" ? 1 : 2}`, displayName: `${owner} Co`, propertySummaries: [{ property: "properties/100", displayName: `${owner} GA4`, propertyType: "PROPERTY_TYPE_ORDINARY" }] }] });
    }
    const prop = /^\/admin\/v1beta\/properties\/(\d+)$/.exec(path);
    if (prop) return send(200, { name: `properties/${prop[1]}`, displayName: `${owner} GA4`, timeZone: owner === "alice" ? "Pacific/Auckland" : "Asia/Kolkata", currencyCode: "USD" });
    if (/^\/data\/v1beta\/properties\/\d+\/metadata$/.test(path)) {
      return send(200, {
        dimensions: [{ apiName: "pagePath", uiName: "Page path", category: "Page / screen" }],
        metrics: [{ apiName: "sessions", uiName: "Sessions", category: "Session", type: "TYPE_INTEGER" }, { apiName: "activeUsers", uiName: "Active users", category: "User", type: "TYPE_INTEGER" }],
      });
    }
    if (/:checkCompatibility$/.test(path)) return send(200, { dimensionCompatibilities: [], metricCompatibilities: [] });
    if (/:runReport$/.test(path)) {
      const dims = (body.dimensions as Array<{ name: string }> | undefined) ?? [];
      const mets = (body.metrics as Array<{ name: string }> | undefined) ?? [];
      return send(200, {
        dimensionHeaders: dims.map((d) => ({ name: d.name })),
        metricHeaders: mets.map((m) => ({ name: m.name, type: "TYPE_INTEGER" })),
        rows: [{ dimensionValues: dims.map(() => ({ value: `${owner}:/home` })), metricValues: mets.map(() => ({ value: String(clicks) })) }],
        rowCount: 1,
        metadata: { timeZone: owner === "alice" ? "Pacific/Auckland" : "Asia/Kolkata", currencyCode: "USD" },
      });
    }
    return send(404, { error: { code: 404, status: "NOT_FOUND" } });
  }
}
