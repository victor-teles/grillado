"use client";

import { cva } from "class-variance-authority";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  OctagonAlert,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/uai-utils";

export const APPROVAL_CARD_RISKS = ["low", "medium", "high", "critical"] as const;
export const APPROVAL_CARD_VARIANTS = ["compact", "detailed"] as const;
export const APPROVAL_CARD_STATUSES = [
  "ready",
  "submitting",
  "approved",
  "rejected",
  "error",
] as const;

export type ApprovalRisk = (typeof APPROVAL_CARD_RISKS)[number];
export type ApprovalCardVariant = (typeof APPROVAL_CARD_VARIANTS)[number];
export type ApprovalCardStatus = (typeof APPROVAL_CARD_STATUSES)[number];
export type ApprovalDecision = "approved" | "rejected";

export type ApprovalConfirmation = {
  phrase: string;
  label?: ReactNode;
  placeholder?: string;
};

type ApprovalRiskProps =
  | { risk?: Exclude<ApprovalRisk, "critical">; confirmation?: never }
  | { risk: "critical"; confirmation: ApprovalConfirmation };

export type ApprovalCardState =
  | { status?: "ready"; pendingDecision?: never }
  | { status: "submitting"; pendingDecision: ApprovalDecision }
  | { status: "approved" | "rejected" | "error"; pendingDecision?: never };

export type ApprovalCardProps = ComponentProps<"section"> &
  ApprovalRiskProps &
  ApprovalCardState & {
    variant?: ApprovalCardVariant;
    disabled?: boolean;
  };

const riskConfig = {
  low: {
    label: "Low risk",
    icon: ShieldCheck,
    iconClassName: "bg-success/14 text-success-ink",
  },
  medium: {
    label: "Medium risk",
    icon: CircleAlert,
    iconClassName: "bg-warning/14 text-warning-ink",
  },
  high: {
    label: "High risk",
    icon: TriangleAlert,
    iconClassName: "bg-destructive/14 text-destructive-ink",
  },
  critical: {
    label: "Critical risk",
    icon: OctagonAlert,
    iconClassName:
      "bg-destructive/14 text-destructive-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--destructive)_28%,transparent)]",
  },
} satisfies Record<
  ApprovalRisk,
  { label: string; icon: typeof ShieldCheck; iconClassName: string }
>;

const approvalCardVariants = cva(
  "rounded-[14px] border bg-card text-card-foreground transition-[border-color,opacity] duration-150 motion-reduce:transition-none",
  {
    variants: {
      variant: { compact: "p-3.5", detailed: "p-4" },
    },
  },
);

type ApprovalCardContextValue = {
  risk: ApprovalRisk;
  variant: ApprovalCardVariant;
  status: ApprovalCardStatus;
  pendingDecision?: ApprovalDecision;
  confirmation?: ApprovalConfirmation;
  confirmationValue: string;
  setConfirmationValue: (value: string) => void;
  confirmationMatches: boolean;
  disabled: boolean;
  isSubmitting: boolean;
  isTerminal: boolean;
  isActionable: boolean;
  titleId: string;
  confirmationId: string;
};

const ApprovalCardContext = createContext<ApprovalCardContextValue | null>(null);

function useApprovalCard(name: string) {
  const context = useContext(ApprovalCardContext);
  if (!context) throw new Error(`${name} must be used within ApprovalCard`);
  return context;
}

export function ApprovalCard(props: ApprovalCardProps) {
  const {
    variant = "compact",
    risk = "medium",
    confirmation,
    status = "ready",
    pendingDecision,
    disabled = false,
    children,
    className,
    "aria-labelledby": ariaLabelledby,
    ...sectionProps
  } = props;
  const titleId = useId();
  const confirmationId = useId();
  const [confirmationValue, setConfirmationValue] = useState("");
  const isSubmitting = status === "submitting";
  const isTerminal = status === "approved" || status === "rejected";
  const isActionable = status === "ready" || status === "error";
  const confirmationMatches =
    risk !== "critical" ||
    (Boolean(confirmation?.phrase) && confirmationValue === confirmation?.phrase);

  useEffect(() => {
    setConfirmationValue((current) => (current === confirmation?.phrase ? current : ""));
  }, [confirmation?.phrase]);

  const context: ApprovalCardContextValue = {
    risk,
    variant,
    status,
    pendingDecision,
    confirmation,
    confirmationValue,
    setConfirmationValue,
    confirmationMatches,
    disabled,
    isSubmitting,
    isTerminal,
    isActionable,
    titleId,
    confirmationId,
  };

  return (
    <ApprovalCardContext.Provider value={context}>
      <section
        data-slot="approval-card"
        className={cn(
          approvalCardVariants({ variant }),
          risk === "critical"
            ? "border-[color-mix(in_oklab,var(--destructive)_40%,var(--border))]"
            : "border-border",
          disabled && "opacity-55",
          className,
        )}
        {...sectionProps}
        aria-busy={isSubmitting}
        aria-labelledby={ariaLabelledby ?? titleId}
        data-variant={variant}
        data-risk={risk}
        data-status={status}
      >
        {children}
      </section>
    </ApprovalCardContext.Provider>
  );
}

export type ApprovalCardHeaderProps = Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  riskLabel?: ReactNode;
  statusLabel?: ReactNode;
};

export function ApprovalCardHeader({
  title,
  description,
  riskLabel,
  statusLabel,
  className,
  ...props
}: ApprovalCardHeaderProps) {
  const context = useApprovalCard("ApprovalCardHeader");
  const riskState = riskConfig[context.risk];
  const RiskIcon = riskState.icon;
  const resolvedStatusLabel =
    statusLabel ??
    {
      ready: "Ready for review",
      submitting: context.pendingDecision === "rejected" ? "Rejecting…" : "Approving…",
      approved: "Approved",
      rejected: "Rejected",
      error: "Decision failed",
    }[context.status];

  return (
    <div
      data-slot="approval-card-header"
      className={cn("flex items-start gap-3", className)}
      {...props}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-[10px]",
          riskState.iconClassName,
        )}
      >
        <RiskIcon className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] leading-4 font-medium",
              riskState.iconClassName,
            )}
          >
            {riskLabel ?? riskState.label}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[11.5px] leading-4 text-subtle-foreground",
              context.status === "approved" && "text-success-ink",
              context.status === "rejected" && "text-muted-foreground",
              context.status === "error" && "text-destructive-ink",
            )}
            role="status"
            aria-live="polite"
          >
            {context.isSubmitting ? (
              <LoaderCircle
                className="size-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : context.status === "approved" ? (
              <Check
                key="approved"
                className="size-3 animate-in duration-200 ease-out-quint fade-in-0 zoom-in-50 motion-reduce:animate-none text-success-ink"
                aria-hidden="true"
              />
            ) : context.status === "rejected" ? (
              <X
                key="rejected"
                className="size-3 animate-in duration-200 ease-out-quint fade-in-0 zoom-in-50 motion-reduce:animate-none text-destructive-ink"
                aria-hidden="true"
              />
            ) : context.status === "error" ? (
              <CircleAlert
                key="error"
                className="size-3 animate-in duration-200 ease-out-quint fade-in-0 zoom-in-50 motion-reduce:animate-none text-destructive-ink"
                aria-hidden="true"
              />
            ) : null}
            <span
              className={cn(
                context.isSubmitting && "shimmer-text motion-reduce:text-muted-foreground!",
              )}
            >
              {resolvedStatusLabel}
            </span>
          </span>
        </div>
        <h3
          id={context.titleId}
          className="mt-2 text-[14px] leading-5 font-medium tracking-[-0.005em] text-balance"
        >
          {title}
        </h3>
        {description ? (
          <p className="mt-1 max-w-[68ch] text-[13px] leading-[19px] text-pretty text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export type ApprovalCardDetailsProps = ComponentProps<"dl">;

export function ApprovalCardDetails({ children, className, ...props }: ApprovalCardDetailsProps) {
  const context = useApprovalCard("ApprovalCardDetails");
  if (context.variant !== "detailed") return null;

  return (
    <dl
      data-slot="approval-card-details"
      className={cn(
        "mt-4 grid gap-x-4 gap-y-3 rounded-[10px] bg-muted/55 p-3 sm:grid-cols-2",
        className,
      )}
      {...props}
    >
      {children}
    </dl>
  );
}

export type ApprovalCardDetailProps = ComponentProps<"div"> & { label: ReactNode };

export function ApprovalCardDetail({
  label,
  children,
  className,
  ...props
}: ApprovalCardDetailProps) {
  return (
    <div data-slot="approval-card-detail" className={cn("min-w-0", className)} {...props}>
      <dt className="text-[11.5px] leading-4 text-subtle-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 text-[13px] leading-[18px] text-foreground [&_code]:rounded-md [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11.5px] [&_li+li]:mt-1 [&_ul]:list-inside [&_ul]:list-disc [&_ul]:marker:text-subtle-foreground">
        {children}
      </dd>
    </div>
  );
}

export type ApprovalCardConfirmationProps = ComponentProps<"div">;

export function ApprovalCardConfirmation({ className, ...props }: ApprovalCardConfirmationProps) {
  const context = useApprovalCard("ApprovalCardConfirmation");
  if (context.risk !== "critical" || context.isTerminal || !context.confirmation) return null;

  return (
    <div data-slot="approval-card-confirmation" className={cn("mt-4", className)} {...props}>
      <Label
        htmlFor={context.confirmationId}
        className="block text-[12.5px] leading-[18px] font-normal text-muted-foreground select-auto"
      >
        {context.confirmation.label ?? (
          <>
            Type{" "}
            <strong className="rounded-md bg-muted px-1.5 py-px font-mono text-[11.5px] font-medium text-foreground">
              {context.confirmation.phrase}
            </strong>{" "}
            to confirm.
          </>
        )}
      </Label>
      <Input
        id={context.confirmationId}
        type="text"
        value={context.confirmationValue}
        placeholder={context.confirmation.placeholder ?? context.confirmation.phrase}
        autoComplete="off"
        spellCheck={false}
        disabled={context.disabled || context.isSubmitting}
        onChange={(event) => context.setConfirmationValue(event.target.value)}
        className="mt-2 h-9 w-full rounded-[10px] border border-transparent bg-background px-3 font-mono text-[12.5px] text-foreground caret-foreground shadow-none outline-none transition-[border-color,box-shadow] duration-[120ms] ease-out selection:bg-foreground/18 selection:text-foreground placeholder:text-subtle-foreground focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-100 motion-reduce:transition-none md:text-[12.5px] dark:bg-background"
      />
    </div>
  );
}

export type ApprovalCardErrorProps = ComponentProps<"p">;

export function ApprovalCardError({ className, children, ...props }: ApprovalCardErrorProps) {
  const context = useApprovalCard("ApprovalCardError");
  if (context.status !== "error") return null;

  return (
    <p
      data-slot="approval-card-error"
      className={cn(
        "mt-4 flex items-start gap-2 rounded-[10px] bg-destructive/10 px-3 py-2.5 text-[13px] leading-[18px] text-foreground",
        className,
      )}
      {...props}
      role="alert"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive-ink" aria-hidden="true" />
      {children}
    </p>
  );
}

export type ApprovalCardActionsProps = ComponentProps<"div">;

export function ApprovalCardActions({ className, children, ...props }: ApprovalCardActionsProps) {
  const context = useApprovalCard("ApprovalCardActions");
  if (context.isTerminal) return null;

  return (
    <div
      data-slot="approval-card-actions"
      className={cn("mt-4 flex flex-wrap items-center justify-end gap-2", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export type ApprovalCardRejectProps = ComponentProps<"button">;

export function ApprovalCardReject({
  children = "Reject",
  className,
  disabled,
  ...props
}: ApprovalCardRejectProps) {
  const context = useApprovalCard("ApprovalCardReject");

  return (
    <Button
      data-slot="approval-card-reject"
      variant="secondary"
      {...props}
      type="button"
      className={cn(
        "h-8 rounded-full px-3.5 py-0 text-[13px] has-[>svg]:px-3.5 transition-[background-color,scale] duration-[140ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--foreground))] focus-visible:ring-2 focus-visible:ring-ring enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:enabled:active:scale-100",
        className,
      )}
      disabled={context.disabled || !context.isActionable || disabled}
    >
      {context.isSubmitting && context.pendingDecision === "rejected" ? "Rejecting…" : children}
    </Button>
  );
}

export type ApprovalCardApproveProps = ComponentProps<"button">;

export function ApprovalCardApprove({
  children = "Approve",
  className,
  disabled: disabledProp,
  ...props
}: ApprovalCardApproveProps) {
  const context = useApprovalCard("ApprovalCardApprove");
  const disabled =
    context.disabled || !context.isActionable || !context.confirmationMatches || disabledProp;

  return (
    <Button
      data-slot="approval-card-approve"
      variant={context.risk === "critical" ? "destructive" : "default"}
      {...props}
      type="button"
      className={cn(
        "h-8 rounded-full px-3.5 py-0 text-[13px] has-[>svg]:px-3.5 transition-[filter,opacity,scale] duration-[140ms] ease-[cubic-bezier(0.23,1,0.32,1)] enabled:hover:brightness-[1.08] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none motion-reduce:enabled:active:scale-100 dark:focus-visible:ring-ring",
        context.risk === "critical"
          ? "bg-destructive text-primary-foreground hover:bg-destructive dark:bg-destructive"
          : "bg-primary text-primary-foreground hover:bg-primary",
        className,
      )}
      disabled={disabled}
    >
      {context.isSubmitting && context.pendingDecision === "approved" ? "Approving…" : children}
    </Button>
  );
}
