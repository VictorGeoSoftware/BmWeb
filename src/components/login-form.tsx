"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { LogIn } from 'lucide-react';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';
import { checkAdminAccess } from '@/lib/admin-access';

function getLoginErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String((error as { code?: string }).code ?? '');
    if (code === 'auth/invalid-credential') return 'Invalid email or password.';
    if (code === 'auth/user-disabled') return 'This account has been disabled.';
    if (code === 'auth/too-many-requests') return 'Too many attempts. Please try again later.';
  }

  if (error instanceof Error) return error.message;
  return 'Unexpected error while logging in.';
}

export default function LoginForm() {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);

      // BmWeb is admin-only: the sole authorization gate is the backend admin
      // allowlist (`admin_users`). Deliberately no `/api/user-data` sync here:
      // that endpoint is BmApp's login handshake and enforces the *app*
      // allowlist (`granted_users`) plus one-device-per-account binding, which
      // must not apply to dashboard administrators.
      const adminAccess = await checkAdminAccess();
      if (adminAccess !== 'granted') {
        await signOut(auth);
        throw new Error(
          adminAccess === 'denied'
            ? 'This account is not authorized to access the dashboard.'
            : 'Could not verify admin access. Please try again later.'
        );
      }

      toast({
        title: "Login Successful",
        description: "Welcome back!",
      });

      router.push('/dashboard');
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Login Failed",
        description: getLoginErrorMessage(error),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleLogin} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="name@example.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
        />
      </div>
      <div className="grid gap-2">
        <div className="flex items-center">
          <Label htmlFor="password">Password</Label>
        </div>
        <Input 
          id="password" 
          type="password"
          placeholder="••••••••"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />
      </div>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? 'Logging in...' : 'Login'}
        {!loading && <LogIn className="ml-2 h-4 w-4" />}
      </Button>
    </form>
  );
}
