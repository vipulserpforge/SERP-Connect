import Link from "next/link";

export const metadata = { title: "Privacy policy" };

// DRAFT written from what the code does. The operator must review it (and have it reviewed where required) and set
// SUPPORT_EMAIL (read at request time) before submitting the app to Google for verification. See docs/GOOGLE-SETUP-SIMPLE.md.
export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  const contact = process.env.SUPPORT_EMAIL;
  return (
    <main className="mx-auto max-w-2xl px-5 py-16 text-sm leading-relaxed">
      <h1 className="text-3xl font-semibold">Privacy policy</h1>
      <p className="mt-2 opacity-70">SEO Analytics Connector lets you ask Claude questions about your own Search Console and Google Analytics 4 data.</p>

      <h2 className="mt-8 text-lg font-medium">What we access from Google</h2>
      <p className="mt-2">
        Only when you choose Connect, and only read-only: Search Console data (<code>webmasters.readonly</code>) and Google Analytics data
        (<code>analytics.readonly</code>), plus your Google account email and a stable account identifier so we can label the connection. We
        cannot change anything in your Google accounts.
      </p>

      <h2 className="mt-8 text-lg font-medium">How we use it</h2>
      <p className="mt-2">
        We use Google user data only to list the properties you can see, and to fetch the reports you or Claude (on your behalf, after you
        approve the connection) request. We do not sell it, use it for advertising, or use it to train models, and no person at our company reads
        it except as needed to operate or secure the service or as the law requires. Our use and transfer of information received from Google
        APIs adheres to the{" "}
        <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2 className="mt-8 text-lg font-medium">What we store, and for how long</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Your account email and the names of the properties you enable.</li>
        <li>Your Google refresh and access tokens, encrypted on our servers. They never reach your browser or Claude.</li>
        <li>Report results are cached briefly (normally 15 minutes, and for up to 24 hours only to show you the last good result if Google is unavailable), then removed.</li>
        <li>Security and audit events (such as connect and disconnect), which do not contain tokens.</li>
      </ul>

      <h2 className="mt-8 text-lg font-medium">Who we share, transfer or disclose Google user data with</h2>
      <p className="mt-2">
        We do not sell Google user data, and we do not share it with advertisers, data brokers or any other third party for their own purposes.
        Google user data is shared or disclosed only in these cases:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <strong>Anthropic (Claude), at your direction.</strong> When you connect Claude and it requests a report, the report results for the
          properties you enabled are returned to Claude so it can answer your question. We never send Google data to Claude unless you have
          connected it and Claude requests it.
        </li>
        <li>
          <strong>Service providers that run our service on our behalf.</strong> Supabase (database and sign-in), Vercel (web dashboard hosting)
          and our virtual private server host (MCP server hosting). They process data only to provide hosting and storage to us, under their
          terms, and may not use it for any other purpose. Stored credentials are encrypted before they reach the database (see below).
        </li>
        <li>
          <strong>Legal and security reasons.</strong> If required by law, legal process or a valid government request, or to protect the rights,
          safety or security of our users or service, to the extent strictly necessary.
        </li>
        <li>
          <strong>Business transfer.</strong> If we are involved in a merger, acquisition or sale of assets, Google user data stays subject to
          this policy and we will tell you first; any new use needs your consent.
        </li>
      </ul>
      <p className="mt-2">We do not allow humans to read Google user data except with your consent for a support request, for security investigation, or where the law requires.</p>

      <h2 className="mt-8 text-lg font-medium">How we protect your data</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <strong>Encryption in transit.</strong> All connections to our website, our MCP server, our database and Google APIs use HTTPS/TLS, and
          database connections verify the server certificate.
        </li>
        <li>
          <strong>Encryption at rest.</strong> Google refresh and access tokens are encrypted with AES-256-GCM using envelope encryption: a
          random key per secret, wrapped by a separately held key-encryption key that is rotatable and is never stored in the database. They are
          decrypted only at the moment a request to Google is made, and are never logged, cached, shown in the browser or sent to Claude.
        </li>
        <li>
          <strong>Access control and tenant isolation.</strong> Every database table has row-level security so each user can only ever reach their
          own rows. Server credentials are kept in environment secrets, not in source code, and the service role is used only on the server.
        </li>
        <li>
          <strong>Least privilege.</strong> We request only read-only Google scopes, and Claude can only read properties you have explicitly
          enabled. You can revoke Claude&apos;s access at any time.
        </li>
        <li>
          <strong>Minimal retention.</strong> Report results are cached for a short time only and then deleted (see above). Disconnecting
          deletes stored credentials, properties and cached reports.
        </li>
        <li>
          <strong>Audit and monitoring.</strong> We record security events such as connect and disconnect, without tokens or report contents, and
          restrict operational access to the people who run the service.
        </li>
      </ul>

      <h2 className="mt-8 text-lg font-medium">What Claude receives</h2>
      <p className="mt-2">
        When you connect Claude, it can request reports for the properties you enabled. Those results are sent to Claude and are then handled under
        Anthropic&apos;s terms and privacy policy. You can remove Claude&apos;s access at any time from the dashboard.
      </p>

      <h2 className="mt-8 text-lg font-medium">Your choices</h2>
      <p className="mt-2">
        Disconnecting an account in the dashboard revokes our token at Google and deletes the stored credentials, properties and cached reports for
        it. You can also remove access at{" "}
        <a className="underline" href="https://myaccount.google.com/permissions">
          myaccount.google.com/permissions
        </a>
        . You can also ask us to delete your account and all data we hold about you by contacting us below; we will do so within 30 days.
      </p>

      <h2 className="mt-8 text-lg font-medium">Changes to this policy</h2>
      <p className="mt-2">
        If we change how we handle Google user data we will update this page and, for material changes, notify you before they take effect.
        Last updated: 2 November 2026.
      </p>

      <h2 className="mt-8 text-lg font-medium">Contact</h2>
      <p className="mt-2">{contact ? <a className="underline" href={`mailto:${contact}`}>{contact}</a> : "Contact details will be published here before launch."}</p>

      <p className="mt-10">
        <Link href="/" className="underline">
          Back to home
        </Link>
      </p>
    </main>
  );
}
