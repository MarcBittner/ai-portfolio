import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Button Component
 *
 * A versatile button component with multiple variants, sizes, and states.
 * Built with class-variance-authority for type-safe variant composition.
 */

const buttonVariants = cva(
  // Base styles
  [
    'inline-flex',
    'items-center',
    'justify-center',
    'gap-2',
    'whitespace-nowrap',
    'rounded-lg',
    'font-medium',
    'transition-all',
    'duration-200',
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-offset-2',
    'disabled:pointer-events-none',
    'disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        primary: [
          'relative',
          'overflow-hidden',
          'bg-gradient-to-br',
          'from-brand-primary',
          'to-brand-secondary',
          'text-white',
          'shadow-lg',
          'shadow-brand-accent/30',
          'hover:shadow-xl',
          'hover:shadow-brand-accent/40',
          'hover:scale-105',
          'active:scale-95',
          'focus-visible:ring-brand-primary',
          'before:absolute',
          'before:inset-0',
          'before:bg-gradient-to-r',
          'before:from-transparent',
          'before:via-white/20',
          'before:to-transparent',
          'before:translate-x-[-200%]',
          'hover:before:translate-x-[200%]',
          'before:transition-transform',
          'before:duration-700',
        ],
        secondary: [
          'bg-gray-100',
          'text-gray-900',
          'hover:bg-gray-200',
          'active:bg-gray-300',
          'focus-visible:ring-gray-400',
          'dark:bg-gray-800',
          'dark:text-gray-100',
          'dark:hover:bg-gray-700',
        ],
        outline: [
          'relative',
          'border-2',
          'border-brand-accent',
          'text-brand-accent',
          'hover:bg-brand-accent',
          'hover:text-white',
          'hover:border-brand-accent',
          'hover:shadow-lg',
          'hover:shadow-brand-accent/30',
          'hover:scale-105',
          'active:scale-95',
          'focus-visible:ring-brand-accent',
          'transition-all',
          'duration-300',
        ],
        ghost: [
          'text-gray-700',
          'hover:bg-gray-100',
          'active:bg-gray-200',
          'focus-visible:ring-gray-400',
          'dark:text-gray-300',
          'dark:hover:bg-gray-800',
        ],
        link: [
          'text-brand-primary',
          'underline-offset-4',
          'hover:underline',
          'focus-visible:ring-brand-primary',
        ],
        destructive: [
          'bg-red-600',
          'text-white',
          'hover:bg-red-700',
          'active:bg-red-800',
          'focus-visible:ring-red-500',
        ],
      },
      size: {
        sm: ['text-sm', 'px-3', 'py-1.5', 'rounded-md'],
        md: ['text-base', 'px-4', 'py-2', 'rounded-lg'],
        lg: ['text-lg', 'px-6', 'py-3', 'rounded-lg'],
        xl: ['text-xl', 'px-8', 'py-4', 'rounded-xl'],
        icon: ['p-2', 'rounded-lg'],
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
      fullWidth: false,
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Show loading state */
  isLoading?: boolean;
  /** Icon to display before the button text */
  startIcon?: React.ReactNode;
  /** Icon to display after the button text */
  endIcon?: React.ReactNode;
  /** Render as a different HTML element or component */
  asChild?: boolean;
}

/**
 * Button component with support for multiple variants, sizes, and states
 *
 * @example
 * ```tsx
 * <Button variant="primary" size="lg">
 *   Click me
 * </Button>
 *
 * <Button variant="outline" startIcon={<IconPlus />}>
 *   Add item
 * </Button>
 *
 * <Button variant="ghost" isLoading>
 *   Loading...
 * </Button>
 * ```
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      fullWidth,
      isLoading = false,
      startIcon,
      endIcon,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, fullWidth, className }))}
        ref={ref}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && (
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {!isLoading && startIcon && (
          <span className="inline-flex shrink-0" aria-hidden="true">
            {startIcon}
          </span>
        )}
        {children}
        {!isLoading && endIcon && (
          <span className="inline-flex shrink-0" aria-hidden="true">
            {endIcon}
          </span>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';

/**
 * Icon Button - Optimized button for icon-only use cases
 *
 * @example
 * ```tsx
 * <IconButton aria-label="Close">
 *   <IconX />
 * </IconButton>
 * ```
 */
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, 'startIcon' | 'endIcon'>
>(({ children, size = 'icon', ...props }, ref) => {
  return (
    <Button ref={ref} size={size} {...props}>
      {children}
    </Button>
  );
});

IconButton.displayName = 'IconButton';

/**
 * Button Group - Container for related buttons
 *
 * @example
 * ```tsx
 * <ButtonGroup>
 *   <Button variant="outline">Left</Button>
 *   <Button variant="outline">Middle</Button>
 *   <Button variant="outline">Right</Button>
 * </ButtonGroup>
 * ```
 */
export interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Orientation of the button group */
  orientation?: 'horizontal' | 'vertical';
  /** Make buttons fill the container width */
  fullWidth?: boolean;
}

export const ButtonGroup = React.forwardRef<HTMLDivElement, ButtonGroupProps>(
  ({ className, orientation = 'horizontal', fullWidth, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'inline-flex',
          orientation === 'horizontal' ? 'flex-row' : 'flex-col',
          fullWidth && 'w-full',
          // Remove rounded corners and borders between buttons
          '[&>button:not(:first-child)]:rounded-l-none',
          '[&>button:not(:last-child)]:rounded-r-none',
          '[&>button:not(:last-child)]:border-r-0',
          className
        )}
        role="group"
        {...props}
      >
        {children}
      </div>
    );
  }
);

ButtonGroup.displayName = 'ButtonGroup';
