'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function MappingsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    document.title = 'Mappings | EL-PIM';
    router.replace('/settings/fields');
  }, [router]);

  return null;
}
