import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Input Component
 *
 * A flexible input component with support for labels, errors, icons, and various states.
 */

const inputVariants = cva(
  [
    'flex',
    'w-full',
    'rounded-lg',
    'border',
    'bg-white',
    'px-3',
    'py-2',
    'text-base',
    'transition-colors',
    'file:border-0',
    'file:bg-transparent',
    'file:text-sm',
    'file:font-medium',
    'placeholder:text-gray-400',
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-offset-2',
    'disabled:cursor-not-allowed',
    'disabled:opacity-50',
    'dark:bg-gray-900',
    'dark:placeholder:text-gray-500',
  ],
  {
    variants: {
      variant: {
        default: [
          'border-gray-300',
          'focus-visible:border-brand-primary',
          'focus-visible:ring-brand-primary/20',
          'dark:border-gray-700',
        ],
        error: [
          'border-red-500',
          'focus-visible:border-red-500',
          'focus-visible:ring-red-500/20',
        ],
        success: [
          'border-green-500',
          'focus-visible:border-green-500',
          'focus-visible:ring-green-500/20',
        ],
      },
      inputSize: {
        sm: ['text-sm', 'px-2', 'py-1.5', 'rounded-md'],
        md: ['text-base', 'px-3', 'py-2', 'rounded-lg'],
        lg: ['text-lg', 'px-4', 'py-3', 'rounded-lg'],
      },
    },
    defaultVariants: {
      variant: 'default',
      inputSize: 'md',
    },
  }
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {
  /** Label text for the input */
  label?: string;
  /** Helper text displayed below the input */
  helperText?: string;
  /** Error message to display */
  error?: string;
  /** Icon to display at the start of the input */
  startIcon?: React.ReactNode;
  /** Icon to display at the end of the input */
  endIcon?: React.ReactNode;
  /** Make label text accessible to screen readers only */
  srOnlyLabel?: boolean;
}

/**
 * Input component with label, error, and icon support
 *
 * @example
 * ```tsx
 * <Input
 *   label="Email"
 *   type="email"
 *   placeholder="you@example.com"
 *   required
 * />
 *
 * <Input
 *   label="Search"
 *   startIcon={<IconSearch />}
 *   placeholder="Search..."
 * />
 *
 * <Input
 *   label="Password"
 *   type="password"
 *   error="Password must be at least 8 characters"
 * />
 * ```
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      variant,
      inputSize,
      type = 'text',
      label,
      helperText,
      error,
      startIcon,
      endIcon,
      srOnlyLabel,
      id,
      ...props
    },
    ref
  ) => {
    // Generate unique ID if not provided
    const inputId = id || React.useId();
    const helperId = helperText || error ? `${inputId}-helper` : undefined;

    // Use error variant if error is present
    const computedVariant = error ? 'error' : variant;

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className={cn(
              'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5',
              srOnlyLabel && 'sr-only'
            )}
          >
            {label}
            {props.required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}

        <div className="relative">
          {startIcon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              {startIcon}
            </div>
          )}

          <input
            ref={ref}
            type={type}
            id={inputId}
            className={cn(
              inputVariants({ variant: computedVariant, inputSize }),
              startIcon && 'pl-10',
              endIcon && 'pr-10',
              className
            )}
            aria-invalid={!!error}
            aria-describedby={helperId}
            {...props}
          />

          {endIcon && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              {endIcon}
            </div>
          )}
        </div>

        {(helperText || error) && (
          <p
            id={helperId}
            className={cn(
              'mt-1.5 text-sm',
              error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'
            )}
          >
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

/**
 * Textarea Component
 *
 * Multi-line text input with resize control
 */
export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  /** Label text for the textarea */
  label?: string;
  /** Helper text displayed below the textarea */
  helperText?: string;
  /** Error message to display */
  error?: string;
  /** Resize behavior */
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
  /** Make label text accessible to screen readers only */
  srOnlyLabel?: boolean;
  /** Custom className */
  className?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      className,
      label,
      helperText,
      error,
      resize = 'vertical',
      srOnlyLabel,
      id,
      ...props
    },
    ref
  ) => {
    const textareaId = id || React.useId();
    const helperId = helperText || error ? `${textareaId}-helper` : undefined;

    const resizeClass = {
      none: 'resize-none',
      vertical: 'resize-y',
      horizontal: 'resize-x',
      both: 'resize',
    }[resize];

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={textareaId}
            className={cn(
              'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5',
              srOnlyLabel && 'sr-only'
            )}
          >
            {label}
            {props.required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}

        <textarea
          ref={ref}
          id={textareaId}
          className={cn(
            inputVariants({ variant: error ? 'error' : 'default' }),
            'min-h-[80px]',
            resizeClass,
            className
          )}
          aria-invalid={!!error}
          aria-describedby={helperId}
          {...props}
        />

        {(helperText || error) && (
          <p
            id={helperId}
            className={cn(
              'mt-1.5 text-sm',
              error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'
            )}
          >
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

/**
 * Input Group - Container for inputs with addons
 *
 * @example
 * ```tsx
 * <InputGroup>
 *   <InputAddon>https://</InputAddon>
 *   <Input placeholder="yoursite.com" />
 * </InputGroup>
 * ```
 */
export interface InputGroupProps extends React.HTMLAttributes<HTMLDivElement> {}

export const InputGroup = React.forwardRef<HTMLDivElement, InputGroupProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex w-full items-stretch',
          '[&>input]:rounded-none',
          '[&>input:first-child]:rounded-l-lg',
          '[&>input:last-child]:rounded-r-lg',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

InputGroup.displayName = 'InputGroup';

/**
 * Input Addon - Prefix/suffix for input groups
 */
export interface InputAddonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'subtle';
}

export const InputAddon = React.forwardRef<HTMLDivElement, InputAddonProps>(
  ({ className, variant = 'default', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center px-3 border border-gray-300 dark:border-gray-700',
          'first:rounded-l-lg last:rounded-r-lg',
          'text-sm text-gray-600 dark:text-gray-400',
          variant === 'default' && 'bg-gray-100 dark:bg-gray-800',
          variant === 'subtle' && 'bg-white dark:bg-gray-900',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

InputAddon.displayName = 'InputAddon';
