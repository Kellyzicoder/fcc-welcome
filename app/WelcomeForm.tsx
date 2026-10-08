"use client";

import { useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { LIMITS, SubmitError, newRequestId, submitSignUp, validate, type FieldErrors, type SignUp, type SupabaseConfig } from "./registration";

const EMPTY: SignUp = { fullName: "", phone: "", email: "", invitedBy: "", notes: "", wantsContact: true };

type Props = { config: SupabaseConfig | null };

export default function WelcomeForm({ config }: Props) {
  const [values, setValues] = useState<SignUp>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [honeypot, setHoneypot] = useState("");
  const [sentName, setSentName] = useState("");
  const [sentWantsContact, setSentWantsContact] = useState(true);
  // One id per sign-up, kept across retries so a resend after a dropped connection can't create a duplicate.
  const requestId = useRef<string>("");

  const set = (field: keyof SignUp) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const raw = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    const value = field === "phone" && typeof raw === "string" ? raw.replace(/[^0-9+ ]/g, "") : raw;  // numbers only
    setValues((v) => ({ ...v, [field]: value }));
    if (errors[field]) setErrors((er) => ({ ...er, [field]: undefined }));
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;
    setProblem(null);
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      document.getElementById(`f-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    if (!config) {
      setProblem("The form isn't connected yet. Please let one of the ushers know — sorry about that!");
      return;
    }
    setStatus("sending");
    try {
      if (!requestId.current) requestId.current = newRequestId();
      if (!honeypot) await submitSignUp(values, config, requestId.current); // bots fill the hidden field; skip them
      requestId.current = ""; // saved: the next person gets a fresh id
      setSentName(values.fullName.trim().split(/\s+/)[0] ?? "");
      setSentWantsContact(values.wantsContact);
      setValues(EMPTY);
      setStatus("done");
    } catch (err) {
      setProblem(err instanceof SubmitError ? err.message : "Something went wrong. Please try again.");
      setStatus("idle");
    }
  }

  if (status === "done") {
    return (
      <section className="thanks" aria-live="polite">
        <div className="tick" aria-hidden="true">✓</div>
        <h2>Thank you{sentName ? `, ${sentName}` : ""}!</h2>
        <p>
          {sentWantsContact
            ? "We're so glad you came. Someone from our welcome team will be in touch this week."
            : "We're so glad you came — we hope to see you again soon."}
        </p>
        <button type="button" className="secondary" onClick={() => setStatus("idle")}>
          Fill in for someone else
        </button>
      </section>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <Field id="fullName" label="Your name" error={errors.fullName} required>
        <input id="f-fullName" name="name" autoComplete="name" maxLength={LIMITS.fullName}
               value={values.fullName} onChange={set("fullName")} aria-invalid={!!errors.fullName}
               aria-describedby={errors.fullName ? "e-fullName" : undefined} />
      </Field>

      <div className="row">
        <Field id="phone" label="Phone" error={errors.phone} required>
          <input id="f-phone" name="tel" type="tel" inputMode="tel" autoComplete="tel" maxLength={LIMITS.phone}
                 value={values.phone} onChange={set("phone")} aria-invalid={!!errors.phone}
                 aria-describedby={errors.phone ? "e-phone" : undefined} />
        </Field>
        <Field id="email" label="Email" error={errors.email}>
          <input id="f-email" name="email" type="email" inputMode="email" autoComplete="email" maxLength={LIMITS.email}
                 value={values.email} onChange={set("email")} aria-invalid={!!errors.email}
                 aria-describedby={errors.email ? "e-email" : undefined} />
        </Field>
      </div>

      <Field id="invitedBy" label="Who invited you, or how did you hear about us?">
        <input id="f-invitedBy" maxLength={LIMITS.invitedBy} value={values.invitedBy} onChange={set("invitedBy")}
               placeholder="e.g. a friend's name, Instagram, walked past" />
      </Field>

      <Field id="notes" label="Anything we can pray about or help with?">
        <textarea id="f-notes" rows={3} maxLength={LIMITS.notes} value={values.notes} onChange={set("notes")} />
      </Field>

      <label className="check">
        <input type="checkbox" checked={values.wantsContact} onChange={set("wantsContact")} />
        <span>I'm happy for someone from FCC to get in touch</span>
      </label>

      {/* Hidden from people; bots tend to fill it in. */}
      <div className="hp" aria-hidden="true">
        <label>Website <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} /></label>
      </div>

      {problem && <p className="problem" role="alert">{problem}</p>}

      <button type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : "Send"}
      </button>
      <p className="privacy">Only the FCC welcome team sees your details. We'll never share them.</p>
    </form>
  );
}

function Field({ id, label, error, required, children }: {
  id: string; label: string; error?: string; required?: boolean; children: ReactNode;
}) {
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label htmlFor={`f-${id}`}>
        {label}
        {required && <span className="req" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error && <p className="error" id={`e-${id}`}>{error}</p>}
    </div>
  );
}
