"use client";

import { cva } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type Ref,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/uai-utils";

export const STATUS_BANNER_VARIANTS = ["card", "tinted", "bar"] as const;
export type StatusBannerVariant = (typeof STATUS_BANNER_VARIANTS)[number];
export type StatusBannerTone = "info" | "success" | "warning" | "error";
export type StatusBannerProps = ComponentProps<"div"> & {
  variant?: StatusBannerVariant;
  tone?: StatusBannerTone;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};
type BannerContext = {
  tone: StatusBannerTone;
  variant: StatusBannerVariant;
  dismiss: () => void;
};
const Context = createContext<BannerContext | null>(null);
function useBanner(part: string) {
  const context = useContext(Context);
  if (!context) throw new Error(`${part} must be used within StatusBanner`);
  return context;
}
const toneClass: Record<StatusBannerTone, string> = {
  info: "[--tone:var(--primary)]",
  success: "[--tone:var(--success)]",
  warning: "[--tone:var(--warning)]",
  error: "[--tone:var(--destructive)]",
};
const toneIcon = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
} as const;

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

const statusBannerVariants = cva(
  "flex min-w-0 animate-in flex-wrap border-solid text-[13px]/[18px] text-foreground duration-240 ease-out-quint fade-in-0 slide-in-from-bottom-1 fill-mode-both data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 data-[state=closed]:ease-out data-[state=closed]:fill-mode-forwards motion-reduce:animate-none",
  {
    variants: {
      variant: {
        card: "items-start gap-3 rounded-[14px] border bg-card p-3.5",
        tinted:
          "items-start gap-3 rounded-xl border-0 bg-[color-mix(in_oklab,var(--tone)_11%,var(--card))] px-3.5 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tone)_18%,transparent)]",
        // The bar sits in flow, so it fades for as long as its row collapses.
        bar: "items-center gap-2.5 rounded-none data-[state=closed]:duration-300 border-0 border-b border-[color-mix(in_oklab,var(--tone)_22%,var(--border))] bg-[color-mix(in_oklab,var(--tone)_8%,var(--card))] px-4 py-2",
      },
    },
  },
);

export function StatusBanner({
  variant = "card",
  tone = "info",
  open,
  defaultOpen = true,
  onOpenChange,
  children,
  className,
  ref,
  ...props
}: StatusBannerProps) {
  const [internal, setInternal] = useState(defaultOpen);
  const visible = open ?? internal;
  const banner = useRef<HTMLDivElement | null>(null);
  const collapse = useRef<HTMLDivElement | null>(null);
  // Stay mounted while the exit plays; reduced motion has no animation, so unmount at once.
  const [rendered, setRendered] = useState(visible);
  if (visible && !rendered) setRendered(true);
  useEffect(() => {
    if (visible) return;
    const node = banner.current;
    const animation = node ? window.getComputedStyle(node).animationName : "";
    if (!animation || animation === "none") return setRendered(false);
    // The in-flow bar also gives its row back instead of letting content jump up.
    collapse.current?.animate?.([{ gridTemplateRows: "1fr" }, { gridTemplateRows: "0fr" }], {
      duration: 300,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      fill: "forwards",
    });
  }, [visible]);
  if (!visible && !rendered) return null;
  const dismiss = () => {
    if (open === undefined) setInternal(false);
    onOpenChange?.(false);
  };
  const urgent = tone === "error" || tone === "warning";
  // Only a closing bar is wrapped, so an open bar stays a direct child (and can be sticky).
  const closingBar = !visible && variant === "bar";
  const element = (
    <div
      role={urgent ? "alert" : "status"}
      data-slot="status-banner"
      className={cn(toneClass[tone], statusBannerVariants({ variant }), className)}
      {...props}
      ref={(node) => {
        banner.current = node;
        assignRef(ref, node);
      }}
      data-variant={variant}
      data-tone={tone}
      data-state={visible ? "open" : "closed"}
      inert={!visible}
      onAnimationEnd={(event) => {
        props.onAnimationEnd?.(event);
        if (event.target === event.currentTarget && !visible) setRendered(false);
      }}
    >
      {children}
    </div>
  );
  return (
    <Context.Provider value={{ tone, variant, dismiss }}>
      {closingBar ? (
        <div ref={collapse} className="grid">
          <div className="min-h-0 overflow-hidden">{element}</div>
        </div>
      ) : (
        element
      )}
    </Context.Provider>
  );
}

export function StatusBannerIcon({ children, className, ...props }: ComponentProps<"span">) {
  const context = useBanner("StatusBannerIcon");
  const Icon = toneIcon[context.tone];
  const chip = context.variant === "card";
  return (
    <span
      aria-hidden="true"
      data-slot="status-banner-icon"
      className={cn(
        "grid flex-none place-items-center rounded-full text-(--tone)",
        chip ? "-my-[5px] size-7 bg-(--tone)/14" : "my-0 size-4.5",
        className,
      )}
      {...props}
    >
      {children ?? <Icon size={chip ? 15 : 16} strokeWidth={1.85} />}
    </span>
  );
}

export function StatusBannerContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="status-banner-content"
      className={cn("grid min-w-0 flex-[1_1_220px] gap-0.5", className)}
      {...props}
    />
  );
}

export function StatusBannerTitle({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="status-banner-title"
      className={cn("m-0 font-medium wrap-anywhere", className)}
      {...props}
    />
  );
}

export function StatusBannerDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="status-banner-description"
      className={cn("m-0 text-[12.5px] text-pretty text-muted-foreground wrap-anywhere", className)}
      {...props}
    />
  );
}

export function StatusBannerActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="status-banner-actions"
      className={cn("ml-auto flex flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  );
}

const actionVariants = cva(
  "cursor-pointer rounded-full py-0 text-foreground transition-[background-color,scale] duration-[120ms,140ms] ease-[ease-out,cubic-bezier(0.23,1,0.32,1)] focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
  {
    variants: {
      variant: {
        card: "h-7 bg-secondary px-3 text-[12.5px]/4 hover:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--foreground))] has-[>svg]:px-3",
        tinted: "h-7 bg-foreground/8 px-3 text-[12.5px]/4 hover:bg-foreground/14 has-[>svg]:px-3",
        bar: "h-6 bg-secondary px-2.5 text-xs/4 hover:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--foreground))] has-[>svg]:px-2.5",
      },
    },
  },
);

export function StatusBannerAction({ className, ...props }: ComponentProps<"button">) {
  const context = useBanner("StatusBannerAction");
  return (
    <Button
      type="button"
      variant="secondary"
      data-slot="status-banner-action"
      className={cn(actionVariants({ variant: context.variant }), className)}
      {...props}
    />
  );
}

export function StatusBannerDismiss({
  children = <X size={14} className="size-3.5" aria-hidden="true" />,
  onClick,
  className,
  ...props
}: ComponentProps<"button">) {
  const context = useBanner("StatusBannerDismiss");
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Dismiss"
      data-slot="status-banner-dismiss"
      className={cn(
        "flex-none cursor-pointer rounded-lg text-subtle-foreground transition-[background-color,color,scale] duration-[120ms,120ms,140ms] ease-[ease-out,ease-out,cubic-bezier(0.23,1,0.32,1)] hover:bg-foreground/8 hover:text-foreground focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.94] motion-reduce:transition-none motion-reduce:active:scale-100 dark:hover:bg-foreground/8 [&_svg:not([class*='size-'])]:size-3.5",
        context.variant === "bar"
          ? "-my-0.75 mr-[-4px] ml-0 size-6"
          : "-my-[5px] mr-[-6px] ml-0 size-7",
        className,
      )}
      {...props}
      type="button"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.dismiss();
      }}
    >
      {children}
    </Button>
  );
}
