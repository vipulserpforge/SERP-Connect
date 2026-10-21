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
        .
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
