import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Flex Component
 *
 * Flexbox layout with convenient props for common patterns
 */

const flexVariants = cva(['flex'], {
  variants: {
    direction: {
      row: 'flex-row',
      'row-reverse': 'flex-row-reverse',
      col: 'flex-col',
      'col-reverse': 'flex-col-reverse',
    },
    align: {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch',
      baseline: 'items-baseline',
    },
    justify: {
      start: 'justify-start',
      center: 'justify-center',
      end: 'justify-end',
      between: 'justify-between',
      around: 'justify-around',
      evenly: 'justify-evenly',
    },
    gap: {
      none: 'gap-0',
      xs: 'gap-1',
      sm: 'gap-2',
      md: 'gap-4',
      lg: 'gap-6',
      xl: 'gap-8',
      '2xl': 'gap-12',
    },
    wrap: {
      wrap: 'flex-wrap',
      'wrap-reverse': 'flex-wrap-reverse',
      nowrap: 'flex-nowrap',
    },
  },
  defaultVariants: {
    direction: 'row',
    align: 'stretch',
    justify: 'start',
    gap: 'none',
    wrap: 'nowrap',
  },
});

export interface FlexProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof flexVariants> {
  /** Render as a different HTML element */
  as?: 'div' | 'section' | 'article' | 'aside' | 'header' | 'footer' | 'main' | 'nav';
}

/**
 * Flex container component for flexible layouts
 *
 * @example
 * ```tsx
 * <Flex direction="row" align="center" gap="md">
 *   <div>Item 1</div>
 *   <div>Item 2</div>
 * </Flex>
 *
 * <Flex direction="col" justify="between" className="h-screen">
 *   <Header />
 *   <Main />
 *   <Footer />
 * </Flex>
 * ```
 */
export const Flex = React.forwardRef<HTMLDivElement, FlexProps>(
  (
    {
      className,
      direction,
      align,
      justify,
      gap,
      wrap,
      as: Component = 'div',
      children,
      ...props
    },
    ref
  ) => {
    return (
      <Component
        ref={ref}
        className={cn(flexVariants({ direction, align, justify, gap, wrap }), className)}
        {...props}
      >
        {children}
      </Component>
    );
  }
);

Flex.displayName = 'Flex';

/**
 * Stack Component
 *
 * Vertical or horizontal stack with consistent spacing
 */
export interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Stack direction */
  direction?: 'vertical' | 'horizontal';
  /** Spacing between items */
  spacing?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  /** Align items */
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  /** Render as a different HTML element */
  as?: 'div' | 'section' | 'article' | 'aside' | 'header' | 'footer' | 'main' | 'nav';
}

/**
 * Stack component for consistent spacing between items
 *
 * @example
 * ```tsx
 * <Stack spacing="md">
 *   <Card>Card 1</Card>
 *   <Card>Card 2</Card>
 *   <Card>Card 3</Card>
 * </Stack>
 *
 * <Stack direction="horizontal" spacing="lg" align="center">
 *   <Button>Action 1</Button>
 *   <Button>Action 2</Button>
 * </Stack>
 * ```
 */
export const Stack = React.forwardRef<HTMLDivElement, StackProps>(
  (
    {
      className,
      direction = 'vertical',
      spacing = 'md',
      align = 'stretch',
      as: Component = 'div',
      children,
      ...props
    },
    ref
  ) => {
    const gapMap = {
      none: 'gap-0',
      xs: 'gap-1',
      sm: 'gap-2',
      md: 'gap-4',
      lg: 'gap-6',
      xl: 'gap-8',
      '2xl': 'gap-12',
    };

    const alignMap = {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch',
      baseline: 'items-baseline',
    };

    return (
      <Component
        ref={ref}
        className={cn(
          'flex',
          direction === 'vertical' ? 'flex-col' : 'flex-row',
          gapMap[spacing],
          alignMap[align],
          className
        )}
        {...props}
      >
        {children}
      </Component>
    );
  }
);

Stack.displayName = 'Stack';

/**
 * Center Component
 *
 * Centers content horizontally and optionally vertically
 */
export interface CenterProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Center vertically as well as horizontally */
  vertical?: boolean;
  /** Max width for centered content */
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  /** Render as a different HTML element */
  as?: 'div' | 'section' | 'article' | 'aside' | 'header' | 'footer' | 'main';
}

/**
 * Center component for centering content
 *
 * @example
 * ```tsx
 * <Center>
 *   <Card>Centered card</Card>
 * </Center>
 *
 * <Center vertical className="min-h-screen">
 *   <Hero />
 * </Center>
 * ```
 */
export const Center = React.forwardRef<HTMLDivElement, CenterProps>(
  (
    {
      className,
      vertical = false,
      maxWidth = 'full',
      as: Component = 'div',
      children,
      ...props
    },
    ref
  ) => {
    const maxWidthMap = {
      sm: 'max-w-screen-sm',
      md: 'max-w-screen-md',
      lg: 'max-w-screen-lg',
      xl: 'max-w-screen-xl',
      '2xl': 'max-w-screen-2xl',
      full: 'max-w-full',
    };

    return (
      <Component
        ref={ref}
        className={cn(
          'mx-auto w-full',
          maxWidthMap[maxWidth],
          vertical && 'flex items-center justify-center',
          className
        )}
        {...props}
      >
        {children}
      </Component>
    );
  }
);

Center.displayName = 'Center';
