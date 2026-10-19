import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

interface FakeUser {
  id: string;
  email: string;
  password: string;
  confirmed: boolean;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * Minimal GoTrue (Supabase Auth) stand-in so the real Next.js app, @supabase/ssr and
 * supabase-js can be driven end to end without a Supabase project or network.
 * It mimics the behaviors that matter for security: unconfirmed users cannot sign in,
 * duplicate sign-ups look identical to new ones, and logout invalidates tokens server-side.
 */
export class FakeGoTrue {
  private server!: Server;
  readonly users = new Map<string, FakeUser>();
  private readonly accessTokens = new Map<string, string>(); // token -> user id
  private readonly refreshTokens = new Map<string, string>();
  url = "";
  /** Lets a test mirror new users into a real database (Supabase keeps auth.users in the same Postgres). */
  onUserCreated?: (user: { id: string; email: string }) => Promise<void>;

  /** Pending OAuth authorization requests, keyed by authorization_id (what Supabase's OAuth server would create). */
  readonly authorizations = new Map<string, { userId: string; clientId: string; clientName: string; redirectUri: string; scope: string; state: string; decision?: "approve" | "deny" }>();
  readonly grants: Array<{ userId: string; clientId: string; name: string }> = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  confirm(email: string): void {
    const u = this.users.get(email);
    if (u) u.confirmed = true;
  }

  idFor(email: string): string | undefined {
    return this.users.get(email)?.id;
  }

  private userJson(u: FakeUser) {
    return { id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  }

  private session(u: FakeUser) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: u.id, email: u.email, aud: "authenticated", role: "authenticated", exp })}.${randomUUID()}`;
    const refresh = randomUUID();
    this.accessTokens.set(access, u.id);
    this.refreshTokens.set(refresh, u.id);
    return { access_token: access, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: refresh, user: this.userJson(u) };
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const err = (status: number, code: string) => send(status, { code: status, error_code: code, msg: code });

    if (req.method === "POST" && url.pathname === "/auth/v1/signup") {
      const { email, password } = (await this.body(req)) as { email: string; password: string };
      if (password.length < 8) return err(422, "weak_password");
      if (!this.users.has(email)) {
        const user = { id: randomUUID(), email, password, confirmed: false };
        this.users.set(email, user);
        await this.onUserCreated?.({ id: user.id, email });
      }
      // Existing and new addresses get the same obfuscated response (confirmation required).
      return send(200, this.userJson(this.users.get(email)!));
    }

    if (req.method === "POST" && url.pathname === "/auth/v1/token") {
      const grant = url.searchParams.get("grant_type");
      const body = await this.body(req);
      if (grant === "password") {
        const u = this.users.get(String(body.email));
        if (!u || u.password !== body.password) return err(400, "invalid_credentials");
        if (!u.confirmed) return err(400, "email_not_confirmed");
        return send(200, this.session(u));
      }
      if (grant === "refresh_token") {
        const id = this.refreshTokens.get(String(body.refresh_token));
        const u = [...this.users.values()].find((x) => x.id === id);
        return u ? send(200, this.session(u)) : err(400, "refresh_token_not_found");
      }
      return err(400, "validation_failed"); // includes grant_type=pkce: no valid code exists
    }

    if (req.method === "GET" && url.pathname === "/auth/v1/user") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const id = this.accessTokens.get(token);
      const u = [...this.users.values()].find((x) => x.id === id);
      return u ? send(200, this.userJson(u)) : err(401, "bad_jwt");
    }

    if (req.method === "POST" && url.pathname === "/auth/v1/logout") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const id = this.accessTokens.get(token);
      if (id) {
        for (const [t, owner] of this.accessTokens) if (owner === id) this.accessTokens.delete(t);
        for (const [t, owner] of this.refreshTokens) if (owner === id) this.refreshTokens.delete(t);
      }
      return send(204);
    }

    const bearerUser = () => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const id = this.accessTokens.get(token);
      return [...this.users.values()].find((x) => x.id === id);
    };

    const authz = /^\/auth\/v1\/oauth\/authorizations\/([^/]+)(\/consent)?$/.exec(url.pathname);
    if (authz) {
      const user = bearerUser();
      if (!user) return err(401, "bad_jwt");
      const a = this.authorizations.get(authz[1]!);
      // A request created for another user looks the same as one that does not exist.
      if (!a || a.userId !== user.id) return err(404, "authorization_not_found");
      if (req.method === "GET" && !authz[2]) {
        if (a.decision === "approve") return send(200, { redirect_url: `${a.redirectUri}?code=fake-code&state=${a.state}` });
        return send(200, {
          authorization_id: authz[1],
          redirect_uri: a.redirectUri,
          client: { id: a.clientId, name: a.clientName, uri: "https://claude.ai", logo_uri: "" },
          user: { id: user.id, email: user.email },
          scope: a.scope,
        });
      }
      if (req.method === "POST" && authz[2]) {
        const { action } = (await this.body(req)) as { action: "approve" | "deny" };
        a.decision = action;
        if (action === "approve" && !this.grants.some((g) => g.userId === user.id && g.clientId === a.clientId)) this.grants.push({ userId: user.id, clientId: a.clientId, name: a.clientName });
        const target = new URL(a.redirectUri);
        target.searchParams.set(action === "approve" ? "code" : "error", action === "approve" ? "fake-code" : "access_denied");
        target.searchParams.set("state", a.state);
        return send(200, { redirect_url: target.toString() });
      }
    }

    if (url.pathname === "/auth/v1/user/oauth/grants") {
      const user = bearerUser();
      if (!user) return err(401, "bad_jwt");
      if (req.method === "GET") {
        return send(200, this.grants.filter((g) => g.userId === user.id).map((g) => ({ client: { id: g.clientId, name: g.name, uri: "https://claude.ai", logo_uri: "" }, scopes: ["email"], granted_at: new Date().toISOString() })));
      }
      if (req.method === "DELETE") {
        const clientId = url.searchParams.get("client_id");
        const i = this.grants.findIndex((g) => g.userId === user.id && g.clientId === clientId);
        if (i >= 0) this.grants.splice(i, 1);
        return send(204);
      }
    }

    return err(404, "not_found");
  }
}
