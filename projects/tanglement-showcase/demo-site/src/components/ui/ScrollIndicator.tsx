'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * ScrollIndicator Component
 *
 * Animated indicator that prompts users to scroll down
 */

export interface ScrollIndicatorProps {
  /** Optional className for custom styling */
  className?: string;
  /** Target section to scroll to (optional) */
  targetId?: string;
}

export const ScrollIndicator = React.forwardRef<HTMLDivElement, ScrollIndicatorProps>(
  ({ className, targetId }, ref) => {
    const [isVisible, setIsVisible] = React.useState(true);

    React.useEffect(() => {
      const handleScroll = () => {
        // Hide indicator after scrolling down 100px
        setIsVisible(window.scrollY < 100);
      };

      window.addEventListener('scroll', handleScroll);
      return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const handleClick = () => {
      if (targetId) {
        const target = document.getElementById(targetId);
        target?.scrollIntoView({ behavior: 'smooth' });
      } else {
        // Scroll down one viewport height
        window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
      }
    };

    if (!isVisible) return null;

    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col items-center gap-2 cursor-pointer transition-opacity duration-300',
          'hover:opacity-70',
          className
        )}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        <span className="text-sm font-medium text-foreground/60">Scroll to explore</span>
        <div className="relative w-6 h-10 border-2 border-foreground/30 rounded-full flex items-start justify-center p-2">
          <div
            className="w-1.5 h-2 bg-foreground/60 rounded-full animate-[scroll-down_1.5s_ease-in-out_infinite]"
            aria-hidden="true"
          />
        </div>
      </div>
    );
  }
);

ScrollIndicator.displayName = 'ScrollIndicator';

/**
 * Add this to your globals.css for the animation:
 *
 * @keyframes scroll-down {
 *   0% {
 *     transform: translateY(0);
 *     opacity: 0;
 *   }
 *   40% {
 *     opacity: 1;
 *   }
 *   80% {
 *     transform: translateY(12px);
 *     opacity: 0;
 *   }
 *   100% {
 *     opacity: 0;
 *   }
 * }
 */
