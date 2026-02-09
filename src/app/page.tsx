import Image from 'next/image';
import LoginForm from '@/components/login-form';
import { PlaceHolderImages } from '@/lib/placeholder-images';
import { Card, CardContent } from '@/components/ui/card';

export default function LoginPage() {
  const loginImage = PlaceHolderImages.find(p => p.id === 'login-background');
  
  return (
    <div className="w-full lg:grid lg:min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-sm space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-bold font-headline text-primary">PriceWise</h1>
              <p className="text-muted-foreground">
                Enter your credentials to access your account
              </p>
            </div>
            <Card>
                <CardContent className="pt-6">
                    <LoginForm />
                </CardContent>
            </Card>
        </div>
      </div>
      <div className="hidden bg-muted lg:block relative">
        {loginImage && (
          <Image
            src={loginImage.imageUrl}
            alt={loginImage.description}
            fill
            priority
            className="object-cover"
            data-ai-hint={loginImage.imageHint}
          />
        )}
      </div>
    </div>
  );
}
