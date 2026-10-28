import { redirect } from "next/navigation";
import { decideAuthorizationAction } from "@/app/actions";
import { getEnv } from "@/lib/env";
import { requireUser } from "@/lib/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";

const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{8,200}$/;

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  email: "See your email address",
  profile: "See your basic profile",
  phone: "See your phone number",
  offline_access: "Stay connected until you remove access",
};

/** Only http(s) targets, so a redirect can never become a javascript: or data: URL. */
function isWebUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="mt-3 text-sm opacity-80">{children}</div>
    </main>
  );
}

/**
 * Consent screen for connecting an AI client (Claude) to this account, reached from Supabase Auth's OAuth server
 * (Authentication > OAuth Server > Authorization Path = /oauth/consent). Shows who is asking and where the user
 * will be sent, then approves or denies through Supabase; the server never grants anything on its own.
 */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { authorization_id: authorizationId } = await searchParams;
  if (!authorizationId || !AUTHORIZATION_ID.test(authorizationId)) {
    return <Message title="Request not found">This authorization link is missing or invalid. Start the connection again from Claude.</Message>;
  }
  await requireUser(`/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`);

  if (getEnv().AUTH_MODE !== "supabase") {
    return <Message title="Not available in mock mode">Connecting Claude needs real sign-in (AUTH_MODE=supabase) and Supabase&apos;s OAuth server.</Message>;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data) {
    return <Message title="Request expired">This authorization request is no longer valid. Start the connection again from Claude.</Message>;
  }
  // Already approved earlier: continue straight back to the client.
  if ("redirect_url" in data) {
    if (!isWebUrl(data.redirect_url)) return <Message title="Request not valid">The return address is not valid.</Message>;
    redirect(data.redirect_url);
  }

  const redirectUrl = new URL(data.redirect_uri);
  const scopes = data.scope.split(/\s+/).filter(Boolean);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirectUrl.hostname);

  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-2xl font-semibold">Connect {data.client.name} to your account?</h1>
      <p className="mt-2 text-sm opacity-70">Signed in as {data.user.email}.</p>

      <section className="card mt-6 text-sm">
        <h2 className="font-medium">{data.client.name} will be able to</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Read data from the accounts you connected here (Search Console, Google Analytics 4, Microsoft Clarity, Bing Webmaster Tools), only for the properties you enabled for Claude.</li>
          <li>Only ever read: it cannot change anything in those accounts or in this app.</li>
        </ul>
        <h2 className="mt-4 font-medium">It will not receive</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Your password, or the Google, Clarity or Bing credentials you saved. Those stay encrypted on our servers.</li>
        </ul>
        {scopes.length > 0 && (
          <p className="mt-4 opacity-70">
            Sign-in details requested: {scopes.map((s) => SCOPE_LABELS[s] ?? `"${s}"`).join(", ")}.
          </p>
        )}
      </section>

      <p className="mt-4 text-sm">
        After you decide, you will be sent to <strong className="break-all">{redirectUrl.host}</strong>.
        {loopback && " That address is on your own computer; only continue if you started this from an app you run yourself."}
      </p>
      {data.client.uri && isWebUrl(data.client.uri) && <p className="mt-1 text-xs opacity-60">App website: {new URL(data.client.uri).host}</p>}

      <form action={decideAuthorizationAction} className="mt-6 flex gap-3">
        <input type="hidden" name="authorizationId" value={authorizationId} />
        <SubmitButton name="decision" value="approve" className="btn-primary">
          Allow
        </SubmitButton>
        <SubmitButton name="decision" value="deny" className="btn-ghost">
          Deny
        </SubmitButton>
      </form>
      <p className="mt-4 text-xs opacity-60">You can remove this access at any time from the dashboard.</p>
    </main>
  );
}
