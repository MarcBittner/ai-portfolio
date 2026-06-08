'use client';

import { useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * Hook for animating text with random character fade-in effect
 *
 * Splits text into individual characters and animates them with staggered fade-in
 */
export function useTextReveal() {
  const elementRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    // Store original text
    const originalText = element.textContent || '';

    // Split text into characters while preserving spaces
    const chars = originalText.split('');

    // Create spans for each character
    element.innerHTML = chars
      .map((char) => {
        if (char === ' ') {
          return '<span style="display: inline-block; width: 0.25em;">&nbsp;</span>';
        }
        return `<span style="display: inline-block; opacity: 0;">${char}</span>`;
      })
      .join('');

    // Get all character spans
    const charSpans = element.querySelectorAll('span');

    // Animate characters with random stagger
    gsap.fromTo(
      charSpans,
      {
        opacity: 0,
      },
      {
        duration: 2,
        opacity: 1,
        stagger: {
          from: 'random',
          each: 0.01,
        },
        ease: 'power2.out',
      }
    );

    // Cleanup function
    return () => {
      element.innerHTML = originalText;
    };
  }, []);

  return elementRef;
}
