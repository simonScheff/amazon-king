import { useState, type FormEvent } from "react";
import { useRedeemLoginLink } from "../api/endpoints";
import { ApiError } from "../api/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface PasteLoginLinkProps {
  /** Called once the pasted link has established a session in this container. */
  onSignedIn?: () => void;
}

/**
 * Sign-in fallback for the installed app: an emailed link always opens in the
 * browser, and on iOS the installed app cannot see the session that link
 * creates, so the link has to be pasted back in here.
 */
export function PasteLoginLink({ onSignedIn }: PasteLoginLinkProps) {
  const [link, setLink] = useState("");
  const redeem = useRedeemLoginLink();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    redeem.mutate(link, { onSuccess: () => onSignedIn?.() });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label htmlFor="login-link" className="text-sm text-zinc-300">
        Paste the sign-in link from your email
      </label>
      <Input
        id="login-link"
        name="login-link"
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        required
        value={link}
        onChange={(event) => setLink(event.target.value)}
        placeholder="https://…/api/session/verify?token=…"
      />
      <p className="text-xs text-zinc-500">
        In the email, press and hold the link, choose <strong>Copy Link</strong>
        , then paste it here.
      </p>
      {redeem.error && (
        <p role="alert" className="text-sm text-red-300">
          {redeem.error instanceof ApiError
            ? redeem.error.message
            : "Could not sign in with that link. Try a new one."}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={redeem.isPending}>
        {redeem.isPending ? "Signing in…" : "Sign in with link"}
      </Button>
    </form>
  );
}
