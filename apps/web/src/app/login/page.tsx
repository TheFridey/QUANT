"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, setToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@odin.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-primary">Paper research terminal</p>
          <h1 className="mt-1 text-2xl font-semibold">ODIN // QUANT</h1>
          <p className="mt-2 text-sm text-muted">Paper trading only. No wallet, no private keys, no live order routing.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        {error ? <p className="text-sm text-loss">{error}</p> : null}
        <Button type="submit" disabled={pending || password.length < 8} className="w-full">
          {pending ? "Checking credentials…" : "Enter terminal"}
        </Button>
        <p className="text-xs text-muted">If you have not changed the local seed, the password is odin-paper-dev.</p>
      </form>
    </main>
  );
}
