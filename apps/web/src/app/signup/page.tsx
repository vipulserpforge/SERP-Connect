import { signUpAction } from "@/app/actions";
import { AuthForm } from "@/app/auth-form";

export const dynamic = "force-dynamic";

export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { error } = await searchParams;
  return <AuthForm mode="signup" action={signUpAction} error={error} />;
}
