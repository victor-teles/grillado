import { cva } from "class-variance-authority";
import { type ComponentProps, createContext, useContext, useId } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/uai-utils";

export const EMPTY_STATE_VARIANTS = ["card", "plain", "compact", "page"] as const;
export const EMPTY_STATE_ACTION_EMPHASES = ["primary", "secondary"] as const;

export type EmptyStateVariant = (typeof EMPTY_STATE_VARIANTS)[number];
export type EmptyStateActionEmphasis = (typeof EMPTY_STATE_ACTION_EMPHASES)[number];

export type EmptyStateProps = ComponentProps<"section"> & {
  variant?: EmptyStateVariant;
};

const emptyStateVariants = cva("w-full min-w-0 text-foreground", {
  variants: {
    variant: {
      card: "flex flex-col items-center gap-[18px] rounded-[14px] border bg-card px-7 py-8 text-center",
      plain:
        "flex flex-col items-center gap-[18px] rounded-none bg-transparent px-5 py-7 text-center",
      compact: "flex items-start gap-3 rounded-xl border bg-card p-3.5 text-left",
      page: "flex min-h-[400px] flex-wrap items-center justify-center gap-8 rounded-none bg-transparent px-8 py-12 text-left",
    },
  },
});

const emptyStateMediaVariants = cva("grid shrink-0 place-items-center border border-transparent", {
  variants: {
    variant: {
      card: "size-11 rounded-xl",
      plain: "size-11 rounded-xl",
      compact: "size-9 rounded-[10px]",
      page: "size-40 rounded-none bg-transparent [font-family:var(--font-geist-mono),ui-monospace,monospace] text-[clamp(3.5rem,10vw,6rem)] leading-none font-semibold tracking-[-0.035em] text-foreground tabular-nums",
    },
  },
  compoundVariants: [
    {
      variant: ["card", "plain", "compact"],
      className:
        "bg-muted text-muted-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,var(--foreground)_6%,transparent)] [&>svg]:size-[42%] [&>svg]:stroke-[1.75]",
    },
  ],
});

const emptyStateTitleVariants = cva("font-medium tracking-[-0.01em] text-balance wrap-anywhere", {
  variants: {
    variant: {
      card: "text-[15px] leading-5",
      plain: "text-[15px] leading-5",
      compact: "text-[13px] leading-[18px]",
      page: "text-xl leading-7 font-semibold tracking-tight",
    },
  },
});

const emptyStateDescriptionVariants = cva("text-pretty text-muted-foreground wrap-anywhere", {
  variants: {
    variant: {
      card: "text-[13px] leading-[19px]",
      plain: "text-[13px] leading-[19px]",
      compact: "text-[12px] leading-[17px]",
      page: "text-sm leading-5",
    },
  },
});

const emptyStateNoteVariants = cva("max-w-[50ch] text-subtle-foreground wrap-anywhere", {
  variants: {
    variant: {
      card: "text-[11.5px] leading-4",
      plain: "text-[11.5px] leading-4",
      compact: "text-[11px] leading-4",
      page: "text-[12px] leading-4",
    },
  },
});

const emptyStateActionVariants = cva(
  "h-auto gap-1.5 rounded-full py-0 no-underline transition-[scale,background-color,filter,opacity] duration-140 ease-out-quint focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        card: "min-h-8 px-3.5 text-[13px]/4 has-[>svg]:px-3.5",
        plain: "min-h-8 px-3.5 text-[13px]/4 has-[>svg]:px-3.5",
        compact: "min-h-7 px-3 text-[12.5px]/4 has-[>svg]:px-3",
        page: "min-h-8.5 px-3.5 text-[13px]/4 has-[>svg]:px-3.5",
      },
      emphasis: {
        primary: "bg-primary text-primary-foreground hover:bg-primary hover:brightness-[1.08]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--foreground))]",
      },
    },
  },
);

const leading = (variant: EmptyStateVariant) => variant === "page" || variant === "compact";

type EmptyStateContextValue = {
  titleId: string;
  variant: EmptyStateVariant;
};

const EmptyStateContext = createContext<EmptyStateContextValue | null>(null);

function useEmptyState(name: string) {
  const context = useContext(EmptyStateContext);
  if (!context) throw new Error(`${name} must be used within EmptyState`);
  return context;
}

export function EmptyState({
  variant = "card",
  children,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  ...props
}: EmptyStateProps) {
  const titleId = useId();

  return (
    <EmptyStateContext.Provider value={{ titleId, variant }}>
      <section
        data-slot="empty-state"
        data-variant={variant}
        className={cn(emptyStateVariants({ variant }), className)}
        {...props}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby ?? (ariaLabel ? undefined : titleId)}
      >
        {children}
      </section>
    </EmptyStateContext.Provider>
  );
}

export type EmptyStateMediaProps = ComponentProps<"div">;

export function EmptyStateMedia({ children, className, ...props }: EmptyStateMediaProps) {
  const { variant } = useEmptyState("EmptyStateMedia");

  return (
    <div
      data-slot="empty-state-media"
      className={cn(emptyStateMediaVariants({ variant }), className)}
      {...props}
    >
      {children}
    </div>
  );
}

export type EmptyStateContentProps = ComponentProps<"div">;

export function EmptyStateContent({ children, className, ...props }: EmptyStateContentProps) {
  const { variant } = useEmptyState("EmptyStateContent");

  return (
    <div
      data-slot="empty-state-content"
      className={cn(
        "flex min-w-0 max-w-[48ch] flex-1 flex-col gap-4",
        leading(variant) ? "items-start text-left" : "items-center text-center",
        variant === "page" && "min-w-[min(100%,260px)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type EmptyStateHeaderProps = ComponentProps<"header">;

export function EmptyStateHeader({ children, className, ...props }: EmptyStateHeaderProps) {
  return (
    <header
      data-slot="empty-state-header"
      className={cn("grid min-w-0 gap-1.5", className)}
      {...props}
    >
      {children}
    </header>
  );
}

export type EmptyStateTitleProps = ComponentProps<"h2">;

export function EmptyStateTitle({ children, className, ...props }: EmptyStateTitleProps) {
  const context = useEmptyState("EmptyStateTitle");

  return (
    <h2
      data-slot="empty-state-title"
      className={cn(emptyStateTitleVariants({ variant: context.variant }), className)}
      {...props}
      id={context.titleId}
    >
      {children}
    </h2>
  );
}

export type EmptyStateDescriptionProps = ComponentProps<"p">;

export function EmptyStateDescription({
  children,
  className,
  ...props
}: EmptyStateDescriptionProps) {
  const { variant } = useEmptyState("EmptyStateDescription");

  return (
    <p
      data-slot="empty-state-description"
      className={cn(emptyStateDescriptionVariants({ variant }), className)}
      {...props}
    >
      {children}
    </p>
  );
}

export type EmptyStateActionsProps = ComponentProps<"div">;

export function EmptyStateActions({ children, className, ...props }: EmptyStateActionsProps) {
  const { variant } = useEmptyState("EmptyStateActions");

  return (
    <div
      data-slot="empty-state-actions"
      className={cn(
        "flex flex-wrap items-center gap-2",
        leading(variant) ? "justify-start" : "justify-center",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type EmptyStateActionAppearanceProps = {
  emphasis?: EmptyStateActionEmphasis;
};

type EmptyStateButtonActionProps = ComponentProps<"button"> &
  EmptyStateActionAppearanceProps & {
    href?: undefined;
  };

type EmptyStateLinkActionProps = ComponentProps<"a"> &
  EmptyStateActionAppearanceProps & {
    href: string;
  };

export type EmptyStateActionProps = EmptyStateButtonActionProps | EmptyStateLinkActionProps;

export function EmptyStateAction({
  emphasis = "primary",
  className,
  ...props
}: EmptyStateActionProps) {
  const { variant } = useEmptyState("EmptyStateAction");
  const actionClassName = cn(emptyStateActionVariants({ variant, emphasis }), className);

  const buttonVariant = emphasis === "primary" ? "default" : "secondary";

  if (typeof props.href === "string") {
    return (
      <Button asChild variant={buttonVariant} className={actionClassName}>
        <a data-slot="empty-state-action" {...props} />
      </Button>
    );
  }

  const { type = "button", ...buttonProps } = props;
  return (
    <Button
      data-slot="empty-state-action"
      variant={buttonVariant}
      {...buttonProps}
      type={type}
      className={actionClassName}
    />
  );
}

export type EmptyStateNoteProps = ComponentProps<"p">;

export function EmptyStateNote({ children, className, ...props }: EmptyStateNoteProps) {
  const { variant } = useEmptyState("EmptyStateNote");

  return (
    <p
      data-slot="empty-state-note"
      className={cn(emptyStateNoteVariants({ variant }), className)}
      {...props}
    >
      {children}
    </p>
  );
}
