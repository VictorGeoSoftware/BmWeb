"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { LogIn } from 'lucide-react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';

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
      const credentials = await signInWithEmailAndPassword(auth, email, password);
      const idToken = await credentials.user.getIdToken();

      const syncResponse = await fetch('/api/user-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idToken,
          userData: {
            uid: credentials.user.uid,
            email: credentials.user.email,
            displayName: credentials.user.displayName,
            photoURL: credentials.user.photoURL,
            providerIds: credentials.user.providerData
              .map((provider) => provider.providerId)
              .filter(Boolean),
          },
        }),
      });

      if (!syncResponse.ok) {
        const responseText = await syncResponse.text();
        throw new Error(responseText || 'Failed to sync user data with backend.');
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
