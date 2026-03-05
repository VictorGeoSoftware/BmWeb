'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { Download, FileUp, LayoutList, LogOut, Trash2 } from 'lucide-react';

export function AppSidebar() {
  const pathname = usePathname();
  const { toast } = useToast();
  const [isFetchingTotalPrices, setIsFetchingTotalPrices] = useState(false);
  const [fetchTotalPricesProgress, setFetchTotalPricesProgress] = useState(0);
  const [isClearing, setIsClearing] = useState(false);
  const [clearProgress, setClearProgress] = useState(0);

  useEffect(() => {
    if (!isFetchingTotalPrices) {
      setFetchTotalPricesProgress(0);
      return;
    }

    setFetchTotalPricesProgress(12);
    const timer = window.setInterval(() => {
      setFetchTotalPricesProgress(prev => (prev >= 90 ? 90 : prev + 8));
    }, 180);

    return () => {
      window.clearInterval(timer);
    };
  }, [isFetchingTotalPrices]);

  useEffect(() => {
    if (!isClearing) {
      setClearProgress(0);
      return;
    }

    setClearProgress(12);
    const timer = window.setInterval(() => {
      setClearProgress(prev => (prev >= 90 ? 90 : prev + 8));
    }, 180);

    return () => {
      window.clearInterval(timer);
    };
  }, [isClearing]);

  const handleFetchTotalPrices = async () => {
    setIsFetchingTotalPrices(true);

    try {
      const response = await fetch('/api/price-proposals/fetch-total-prices', {
        method: 'POST',
      });

      const responseText = await response.text();
      const payload = responseText ? JSON.parse(responseText) : {};

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Failed to fetch Total prices');
      }

      setFetchTotalPricesProgress(100);
      window.dispatchEvent(new Event('price-proposals-refresh-requested'));

      toast({
        title: 'Total prices fetch started',
        description: payload?.message ?? 'The workflow was triggered successfully.',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Fetch Total prices failed',
        description: error instanceof Error ? error.message : 'Unexpected error while triggering workflow',
      });
    } finally {
      setIsFetchingTotalPrices(false);
    }
  };

  const handleClearAllData = async () => {
    if (!window.confirm('This will permanently delete all stored data. Continue?')) {
      return;
    }

    setIsClearing(true);

    try {
      const response = await fetch('/api/price-proposals/clear-all-data', {
        method: 'DELETE',
      });

      const responseText = await response.text();
      const payload = responseText ? JSON.parse(responseText) : {};

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Failed to clear all data');
      }

      setClearProgress(100);
      window.dispatchEvent(new Event('price-proposals-cleared'));

      toast({
        title: 'Data cleared',
        description: 'All stored price proposal data has been removed.',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Clear all data failed',
        description: error instanceof Error ? error.message : 'Unexpected error while clearing data',
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center justify-between">
            <Link href="/dashboard" className="flex items-center gap-2">
                <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center shrink-0">
                    <span className="font-bold text-primary-foreground text-sm">PW</span>
                </div>
                <h2 className="text-2xl font-bold font-headline text-primary group-data-[collapsible=icon]:hidden">PriceWise</h2>
            </Link>
          <SidebarTrigger className="group-data-[collapsible=icon]:hidden" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === '/dashboard'}
              tooltip={{ children: 'Upload Prices', side: 'right' }}
            >
              <Link href="/dashboard">
                <FileUp />
                <span>Upload Prices</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith('/dashboard/price-proposals')}
              tooltip={{ children: 'Price Proposals', side: 'right' }}
            >
              <Link href="/dashboard/price-proposals">
                <LayoutList />
                <span>Price Proposals</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleFetchTotalPrices}
              disabled={isFetchingTotalPrices}
              tooltip={{ children: "Fetch Total's prices", side: 'right' }}
            >
              <Download />
              <span>{isFetchingTotalPrices ? 'Fetching prices...' : "Fetch Total's prices"}</span>
            </SidebarMenuButton>
            {isFetchingTotalPrices && (
              <div className="px-2 pt-2 group-data-[collapsible=icon]:hidden">
                <Progress value={fetchTotalPricesProgress} className="h-1.5" />
              </div>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleClearAllData}
              disabled={isClearing}
              tooltip={{ children: 'Clear all data', side: 'right' }}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 />
              <span>{isClearing ? 'Clearing...' : 'Clear all data'}</span>
            </SidebarMenuButton>
            {isClearing && (
              <div className="px-2 pt-2 group-data-[collapsible=icon]:hidden">
                <Progress value={clearProgress} className="h-1.5" />
              </div>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={{ children: 'Logout', side: 'right' }}>
              <Link href="/">
                <LogOut />
                <span>Logout</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
