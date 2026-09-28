'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createShareVariationSession } from '../lib/share-variation.mjs';

// Randomness is used only in an effect or an explicit user action, never during SSR/render.
const shareSession = createShareVariationSession();
function sessionStorageIfAvailable() {
  try { return window.sessionStorage; } catch { return undefined; }
}

export default function useShareVariation() {
  const [variation, setVariation] = useState(null);
  const current = useRef(null);
  useEffect(() => {
    // React Strict Mode repeats effects; preserve the first draw for this card.
    if (!current.current) current.current = shareSession.open(sessionStorageIfAvailable());
    setVariation(current.current);
  }, []);
  const changeVariation = useCallback(() => {
    current.current = shareSession.change(current.current, sessionStorageIfAvailable());
    setVariation(current.current);
  }, []);
  return {
    posterId: variation?.posterId || 'original',
    mottoIndex: variation?.mottoIndex || 0,
    ready: variation !== null,
    changeVariation,
  };
}
