"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";

/** A form submit button that shows a spinner and blocks double submits while its server action runs. */
export function SubmitButton({ children, disabled, ...rest }: ComponentProps<"button">) {
  const { pending } = useFormStatus();
  return (
    <button {...rest} type="submit" disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
