import Link from "next/link";
import { AUTH_ERRORS, AUTH_NOTICES, isAuthErrorCode, isAuthNoticeCode } from "@serp/auth";
import { signInWithGoogleAction } from "@/app/actions";
import { AnswerCard } from "@/components/answer-card";
import { EXAMPLES } from "@/components/examples";
import { SubmitButton } from "@/components/submit-button";

interface Props {
  mode: "login" | "signup";
  action: (formData: FormData) => Promise<void>;
  error?: string;
  notice?: string;
  next?: string;
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

const BENEFITS = ["Read-only access: nothing in your accounts can change", "You choose which properties Claude can see", "Credentials stay encrypted on the server"];

/** Server-rendered form: works without JS. Messages come from a fixed allowlist keyed by code. */
export function AuthForm({ mode, action, error, notice, next }: Props) {
  const isLogin = mode === "login";
  return (
    <main className="container-x grid min-h-[calc(100vh-14rem)] items-center gap-12 py-10 sm:py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
      {/* Product panel: desktop only, so phones go straight to the form. */}
      <section aria-label="About SERP Connect" className="hidden lg:block">
        <p className="pill" style={{ color: "var(--teal)" }}>
          Search Console + GA4 + Clarity + Bing, for Claude
        </p>
        <h2 className="mt-6 max-w-lg text-5xl font-medium leading-[1.05] tracking-tight">
          Ask Claude about your <span className="accent">SEO data.</span>
        </h2>
        <ul className="mt-7 space-y-3">
          {BENEFITS.map((b) => (
            <li key={b} className="flex items-start gap-3 text-base muted">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: "var(--teal)" }}>
                <path d="M5 12l4 4L19 7" />
              </svg>
              {b}
            </li>
          ))}
        </ul>
        <div className="mt-9 max-w-lg">
          <AnswerCard example={EXAMPLES[0]!} compact />
        </div>
      </section>

      <section className="mx-auto w-full max-w-md">
        <div className="rounded-3xl p-6 sm:p-8" style={{ border: "1px solid var(--line)", background: "rgba(9,26,24,0.85)" }}>
          <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">
            {isLogin ? (
              <>
                Welcome <span className="accent">back</span>
              </>
            ) : (
              <>
                Create your <span className="accent">account</span>
              </>
            )}
          </h1>
          <p className="muted mt-2">{isLogin ? "Sign in to manage your connections." : "Free to start. Connect your data afterwards."}</p>
          {isAuthNoticeCode(notice) && (
            <p role="status" className="alert tone-ok mt-5">
              {AUTH_NOTICES[notice]}
            </p>
          )}
          {isAuthErrorCode(error) && (
            <p role="alert" className="alert tone-err mt-5">
              {AUTH_ERRORS[error]}
            </p>
          )}

          {/* DOM order keeps the email form first (stable for tests); `order` shows Google on top. */}
          <div className="mt-6 flex flex-col">
            <form action={action} className="order-3 space-y-4">
              {next && <input type="hidden" name="next" value={next} />}
              <label className="block text-sm font-medium">
                Email
                <input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@company.com" className="field font-normal" />
              </label>
              <label className="block text-sm font-medium">
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  required
                  minLength={8}
                  maxLength={72}
                  placeholder={isLogin ? "Your password" : "At least 8 characters"}
                  className="field font-normal"
                />
              </label>
              <SubmitButton className="btn-primary !min-h-12 w-full text-base">{isLogin ? "Sign in" : "Sign up"}</SubmitButton>
            </form>
            <p className="muted order-2 my-5 flex items-center gap-3 text-xs">
              <span className="h-px flex-1" style={{ background: "var(--line)" }} />
              or use email
              <span className="h-px flex-1" style={{ background: "var(--line)" }} />
            </p>
            <form action={signInWithGoogleAction} className="order-1">
              <SubmitButton className="btn-ghost !min-h-12 w-full">
                <GoogleMark />
                Continue with Google
              </SubmitButton>
            </form>
          </div>
        </div>
        <p className="muted mt-6 text-center">
          {isLogin ? "New here? " : "Already registered? "}
          <Link href={isLogin ? "/signup" : "/login"} className="inline-flex min-h-11 items-center underline" style={{ color: "var(--teal)" }}>
            {isLogin ? "Create an account" : "Sign in"}
          </Link>
        </p>
      </section>
    </main>
  );
}
