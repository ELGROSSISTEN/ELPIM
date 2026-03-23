'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function MappingsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    document.title = 'Mappings | ePIM';
    router.replace('/settings/fields');
  }, [router]);

  return null;
}
