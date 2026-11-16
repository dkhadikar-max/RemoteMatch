'use client';

import { useLayoutEffect } from 'react';
import {
  installPreviewDemoFetchMock,
  uninstallPreviewDemoFetchMock,
} from '@/lib/preview-demo/mock-fetch';

export function PreviewDemoProvider({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    installPreviewDemoFetchMock();
    return () => uninstallPreviewDemoFetchMock();
  }, []);

  return <>{children}</>;
}
