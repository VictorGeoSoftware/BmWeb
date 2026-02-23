import type { Metadata } from 'next';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import AuthGuard from '@/components/auth-guard';

export const metadata: Metadata = {
  title: 'Dashboard - PriceWise',
  description: 'Manage your electricity prices.',
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <div className="p-4 sm:p-6 lg:p-8">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </AuthGuard>
  );
}
