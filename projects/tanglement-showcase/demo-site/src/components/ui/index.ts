/**
 * UI Component Library
 *
 * Reusable, accessible UI components built with Tailwind CSS and Radix UI primitives.
 */

// Form Components
export {
  Form,
  FormField,
  FormTextarea,
  FormSelect,
  FormError,
  useFormContext,
  type FormProps,
  type FormFieldProps,
  type FormTextareaProps,
  type FormSelectProps,
  type FormErrorProps,
} from './Form';

// Button Components
export {
  Button,
  IconButton,
  ButtonGroup,
  type ButtonProps,
  type ButtonGroupProps,
} from './Button';

// Input Components
export {
  Input,
  Textarea,
  InputGroup,
  InputAddon,
  type InputProps,
  type TextareaProps,
  type InputGroupProps,
  type InputAddonProps,
} from './Input';

// Scroll Indicator
export { ScrollIndicator, type ScrollIndicatorProps } from './ScrollIndicator';

// Background Effects
export { ImmersiveBackground, type ImmersiveBackgroundProps } from './ImmersiveBackground';
export { FluidBackground, type FluidBackgroundProps } from './FluidBackground';
