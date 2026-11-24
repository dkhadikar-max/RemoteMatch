'use client';

import { useEffect } from 'react';
import {
  installPreviewDemoFetchMock,
  uninstallPreviewDemoFetchMock,
} from '@/lib/preview-demo/mock-fetch';

// Installed synchronously during render (not inside an effect): React runs
// effects — including useLayoutEffect — children-first, so a child page's
// own useEffect(load) can fire its first fetch() before this component's
// effect would install the mock, hitting the real, unmocked backend.
// Calling it here, during this component's own render, guarantees the mock
// is in place before any descendant can mount and fetch.
// installPreviewDemoFetchMock() is idempotent (no-ops if already
// installed), so repeated renders are safe.
export function PreviewDemoProvider({ children }: { children: React.ReactNode }) {
  if (typeof window !== 'undefined') {
    installPreviewDemoFetchMock();
  }

  useEffect(() => {
    return () => uninstallPreviewDemoFetchMock();
  }, []);

  return <>{children}</>;
}
