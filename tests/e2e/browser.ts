/** Shared by the e2e files: a cookie jar over fetch that replays Next.js server-action forms without JavaScript. */
let base = "";
export const setBase = (url: string) => void (base = url);
export async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}
export const location = (r: Response) => r.headers.get("location") ?? "";

/** Tiny cookie jar + manual-redirect fetch. */
export class Browser {
  cookies = new Map<string, string>();

  private store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(base + path, {
      redirect: "manual",
      ...init,
      headers: { ...(cookie && { cookie }), origin: base, ...(init.headers as Record<string, string>) },
    });
    this.store(res);
    return res;
  }

  /** Submits a server-action form without JS: replays the hidden $ACTION fields Next renders. */
  async submitForm(page: string, fields: Record<string, string>, formIndex = 0): Promise<Response> {
    // When signed in, the site header's sign-out form is form 0 on every page.
    const html = await (await this.request(page)).text();
    const form = html.split("<form")[formIndex + 1] ?? "";
    const form1 = form.split("</form>")[0] ?? "";
    const form2 = new FormData();
    for (const m of form1.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(m[0])?.[1];
      const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
      if (name?.startsWith("$ACTION")) form2.append(name, value);
    }
    for (const [k, v] of Object.entries(fields)) form2.set(k, v);
    return this.request(page, { method: "POST", body: form2 });
  }
}

