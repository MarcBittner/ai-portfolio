'use client';

import * as React from 'react';
import {
  useForm,
  UseFormReturn,
  FieldValues,
  SubmitHandler,
  UseFormProps,
  Path,
  FieldPath,
  Controller,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z, ZodSchema } from 'zod';
import { cn } from '@/lib/utils';

/**
 * Form Components
 *
 * Type-safe form components integrated with react-hook-form and Zod validation.
 */

/**
 * Form Context
 */
const FormContext = React.createContext<UseFormReturn<FieldValues> | null>(null);

function useFormContext<TFieldValues extends FieldValues = FieldValues>() {
  const context = React.useContext(FormContext);
  if (!context) {
    throw new Error('Form components must be used within a Form component');
  }
  return context as UseFormReturn<TFieldValues>;
}

/**
 * Form Component
 *
 * Root form component that provides context for form fields
 *
 * @example
 * ```tsx
 * const schema = z.object({
 *   email: z.string().email(),
 *   password: z.string().min(8),
 * });
 *
 * <Form
 *   schema={schema}
 *   onSubmit={(data) => console.log(data)}
 * >
 *   <FormField name="email" label="Email" />
 *   <FormField name="password" label="Password" type="password" />
 *   <Button type="submit">Submit</Button>
 * </Form>
 * ```
 */
export interface FormProps<TFieldValues extends FieldValues>
  extends Omit<React.FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  /** Zod validation schema */
  schema?: ZodSchema<TFieldValues>;
  /** Form submit handler */
  onSubmit: SubmitHandler<TFieldValues>;
  /** react-hook-form configuration */
  formOptions?: Omit<UseFormProps<TFieldValues>, 'resolver'>;
  /** External form instance (for advanced use cases) */
  form?: UseFormReturn<TFieldValues>;
  /** Children components */
  children: React.ReactNode;
}

export function Form<TFieldValues extends FieldValues = FieldValues>({
  schema,
  onSubmit,
  formOptions,
  form: externalForm,
  children,
  className,
  ...props
}: FormProps<TFieldValues>) {
  // Use external form or create internal one
  const internalForm = useForm<TFieldValues>({
    ...formOptions,
    ...(schema && { resolver: zodResolver(schema) }),
  });

  const form = externalForm || internalForm;

  return (
    <FormContext.Provider value={form as UseFormReturn<FieldValues>}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={cn('space-y-4', className)}
        {...props}
      >
        {children}
      </form>
    </FormContext.Provider>
  );
}

/**
 * Form Field Component
 *
 * Integrated input field with automatic validation
 */
export interface FormFieldProps<TFieldValues extends FieldValues>
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'size'> {
  /** Field name (must match schema) */
  name: Path<TFieldValues>;
  /** Label text */
  label?: string;
  /** Helper text */
  helperText?: string;
  /** Input size */
  inputSize?: 'sm' | 'md' | 'lg';
  /** Icon at start */
  startIcon?: React.ReactNode;
  /** Icon at end */
  endIcon?: React.ReactNode;
  /** Make label screen reader only */
  srOnlyLabel?: boolean;
}

export function FormField<TFieldValues extends FieldValues = FieldValues>({
  name,
  label,
  helperText,
  inputSize = 'md',
  startIcon,
  endIcon,
  srOnlyLabel,
  className,
  ...props
}: FormFieldProps<TFieldValues>) {
  const {
    register,
    formState: { errors },
  } = useFormContext<TFieldValues>();

  const error = errors[name]?.message as string | undefined;

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={name}
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
          id={name}
          className={cn(
            'flex w-full rounded-lg border px-3 py-2 text-base transition-colors',
            'file:border-0 file:bg-transparent file:text-sm file:font-medium',
            'placeholder:text-gray-400',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'dark:bg-gray-900 dark:placeholder:text-gray-500',
            error
              ? 'border-red-500 focus-visible:border-red-500 focus-visible:ring-red-500/20'
              : 'border-gray-300 focus-visible:border-brand-primary focus-visible:ring-brand-primary/20 dark:border-gray-700',
            inputSize === 'sm' && 'text-sm px-2 py-1.5 rounded-md',
            inputSize === 'lg' && 'text-lg px-4 py-3',
            startIcon && 'pl-10',
            endIcon && 'pr-10',
            className
          )}
          aria-invalid={!!error}
          {...register(name)}
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

/**
 * Form Textarea Component
 */
export interface FormTextareaProps<TFieldValues extends FieldValues>
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'name'> {
  /** Field name (must match schema) */
  name: Path<TFieldValues>;
  /** Label text */
  label?: string;
  /** Helper text */
  helperText?: string;
  /** Resize behavior */
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
  /** Make label screen reader only */
  srOnlyLabel?: boolean;
}

export function FormTextarea<TFieldValues extends FieldValues = FieldValues>({
  name,
  label,
  helperText,
  resize = 'vertical',
  srOnlyLabel,
  className,
  ...props
}: FormTextareaProps<TFieldValues>) {
  const {
    register,
    formState: { errors },
  } = useFormContext<TFieldValues>();

  const error = errors[name]?.message as string | undefined;

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
          htmlFor={name}
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
        id={name}
        className={cn(
          'flex w-full rounded-lg border px-3 py-2 text-base transition-colors',
          'placeholder:text-gray-400 min-h-[80px]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-gray-900 dark:placeholder:text-gray-500',
          error
            ? 'border-red-500 focus-visible:border-red-500 focus-visible:ring-red-500/20'
            : 'border-gray-300 focus-visible:border-brand-primary focus-visible:ring-brand-primary/20 dark:border-gray-700',
          resizeClass,
          className
        )}
        aria-invalid={!!error}
        {...register(name)}
        {...props}
      />

      {(helperText || error) && (
        <p
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

/**
 * Form Select Component
 */
export interface FormSelectProps<TFieldValues extends FieldValues>
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'name'> {
  /** Field name (must match schema) */
  name: Path<TFieldValues>;
  /** Label text */
  label?: string;
  /** Helper text */
  helperText?: string;
  /** Select options */
  options: Array<{ value: string; label: string }>;
  /** Make label screen reader only */
  srOnlyLabel?: boolean;
}

export function FormSelect<TFieldValues extends FieldValues = FieldValues>({
  name,
  label,
  helperText,
  options,
  srOnlyLabel,
  className,
  ...props
}: FormSelectProps<TFieldValues>) {
  const {
    register,
    formState: { errors },
  } = useFormContext<TFieldValues>();

  const error = errors[name]?.message as string | undefined;

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={name}
          className={cn(
            'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5',
            srOnlyLabel && 'sr-only'
          )}
        >
          {label}
          {props.required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}

      <select
        id={name}
        className={cn(
          'flex w-full rounded-lg border px-3 py-2 text-base transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-gray-900',
          error
            ? 'border-red-500 focus-visible:border-red-500 focus-visible:ring-red-500/20'
            : 'border-gray-300 focus-visible:border-brand-primary focus-visible:ring-brand-primary/20 dark:border-gray-700',
          className
        )}
        aria-invalid={!!error}
        {...register(name)}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {(helperText || error) && (
        <p
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

/**
 * Form Error Message Component
 *
 * Display form-level or field-level errors
 */
export interface FormErrorProps {
  /** Field name to show error for */
  name?: string;
  /** Custom error message */
  message?: string;
}

export function FormError({ name, message }: FormErrorProps) {
  const {
    formState: { errors },
  } = useFormContext();

  const error = name ? (errors[name]?.message as string | undefined) : message;

  if (!error) return null;

  return (
    <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 border border-red-200 dark:border-red-800">
      <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
    </div>
  );
}

/**
 * Export useFormContext for advanced use cases
 */
export { useFormContext };
