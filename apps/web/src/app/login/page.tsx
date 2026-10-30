"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, setToken, takeLoginNotice } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@odin.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setNotice(takeLoginNotice());
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(result.token);
      router.push("/terminal");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(36,48,68,0.25)_1px,transparent_1px),linear-gradient(90deg,rgba(36,48,68,0.25)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-primary/10 to-transparent" />
      <form onSubmit={onSubmit} className="panel relative w-full max-w-md space-y-4 rounded-md p-6">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-primary">Paper research terminal</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[0.08em]">ODIN // QUANT</h1>
          <p className="mt-2 text-sm text-muted">
            Quantitative command centre for Solana paper trading. No wallet, no private keys, no live order routing.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {notice ? (
          <p role="status" className="text-sm text-warning">
            {notice}
          </p>
        ) : null}
        {error ? <p className="text-sm text-loss">{error}</p> : null}
        <Button type="submit" disabled={pending || password.length < 8} className="w-full">
          {pending ? "Authenticating…" : "Enter command centre"}
        </Button>
        <p className="text-xs text-muted">Local seed password remains odin-paper-dev unless rotated.</p>
      </form>
    </main>
  );
}
