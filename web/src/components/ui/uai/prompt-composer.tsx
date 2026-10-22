"use client";

import { cva } from "class-variance-authority";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  LoaderCircle,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/uai-utils";

export type PromptComposerModel = {
  id: string;
  label: string;
};

export const PROMPT_COMPOSER_VARIANTS = ["rounded", "pill", "ghost", "compact"] as const;

export type PromptComposerVariant = (typeof PROMPT_COMPOSER_VARIANTS)[number];

export type PromptComposerProps = Omit<ComponentProps<"form">, "onSubmit" | "onChange"> & {
  variant?: PromptComposerVariant;
  busy?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (prompt: string, files: File[]) => void | Promise<void>;
};

type Attachment = { id: string; file: File };
type OpenMenu = "add" | "model" | null;

const promptComposerCardVariants = cva(
  "relative isolate flex flex-col border bg-card transition-colors duration-150 focus-within:border-border-strong",
  {
    variants: {
      variant: {
        rounded: "gap-1.5 rounded-[14px] p-1.5",
        pill: "gap-1 p-1",
        ghost: "gap-1.5 rounded-[14px] border-transparent bg-transparent p-1",
        compact: "gap-1 rounded-xl p-1",
      },
      open: { true: "", false: "" },
      invalid: { true: "border-destructive focus-within:border-destructive", false: "" },
    },
    compoundVariants: [
      { variant: "pill", open: false, className: "rounded-full" },
      { variant: "pill", open: true, className: "rounded-3xl" },
    ],
  },
);

function composerChrome(variant: PromptComposerVariant) {
  const compact = variant === "compact";
  const pill = variant === "pill";

  return {
    compact,
    pill,
    controlSize: compact ? 24 : 28,
    controlClass: compact ? "size-6" : "size-7",
    controlHeightClass: compact ? "h-6" : "h-7",
    controlRadiusClass: pill ? "rounded-full" : compact ? "rounded-[6px]" : "rounded-lg",
    chipClass: cn(
      compact ? "h-5.5 text-[11px]" : "h-6.5 text-[11.5px]",
      pill ? "rounded-full" : compact ? "rounded-[5px]" : "rounded-md",
    ),
    fieldClass: compact
      ? "min-h-6 py-1 text-[12.5px]/4 md:text-[12.5px]/4"
      : "min-h-7 py-1.25 text-[13px]/[18px] md:text-[13px]/[18px]",
    maxFieldHeightClass: compact ? "max-h-20" : "max-h-[100px]",
    modelClass: compact ? "text-[11px]" : "text-xs",
    iconClass: compact ? "size-3.5" : "size-4",
  };
}

type PromptComposerContextValue = {
  prompt: string;
  setPrompt: (value: string) => void;
  attachments: Attachment[];
  addFiles: (files: File[]) => void;
  removeAttachment: (id: string) => void;
  busy: boolean;
  invalid: boolean;
  locked: boolean;
  canSend: boolean;
  expanded: boolean;
  openMenu: OpenMenu;
  setOpenMenu: Dispatch<SetStateAction<OpenMenu>>;
  inputId: string;
  controlsRef: React.RefObject<HTMLDivElement | null>;
  addRef: React.RefObject<HTMLDivElement | null>;
  actionsRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Set while a closed menu hands focus back to its trigger, which forwards it to the input. */
  focusInputOnReturnRef: React.RefObject<boolean>;
  /** Set while the file picker is up, so the menu (and its file input) stays mounted. */
  keepMenuOpenRef: React.RefObject<boolean>;
  chrome: ReturnType<typeof composerChrome>;
};

const PromptComposerContext = createContext<PromptComposerContextValue | null>(null);

function usePromptComposer(name: string) {
  const context = useContext(PromptComposerContext);
  if (!context) throw new Error(`${name} must be used within PromptComposer`);
  return context;
}

function menuOpenChange(context: PromptComposerContextValue, menu: Exclude<OpenMenu, null>) {
  return (open: boolean) => {
    if (!open && context.keepMenuOpenRef.current) return;
    context.setOpenMenu((current) => (open ? menu : current === menu ? null : current));
  };
}

/** Clears a flag on the next key or pointer press anywhere, so a pending hand-off can't go stale. */
function expireOnNextInput(flag: React.RefObject<boolean>) {
  const expire = () => {
    flag.current = false;
    document.removeEventListener("keydown", expire, true);
    document.removeEventListener("pointerdown", expire, true);
  };
  document.addEventListener("keydown", expire, true);
  document.addEventListener("pointerdown", expire, true);
  return expire;
}

/**
 * Menu triggers forward the focus their menu returns on close to the input. Radix and Base UI
 * both restore focus to the trigger, so this works on either without primitive-specific props.
 */
function forwardReturnedFocus(context: PromptComposerContextValue) {
  return () => {
    if (!context.focusInputOnReturnRef.current) return;
    context.focusInputOnReturnRef.current = false;
    context.inputRef.current?.focus();
  };
}

function FloatingMenu({ kind, children }: { kind: "sources" | "models"; children: ReactNode }) {
  usePromptComposer("PromptComposerMenu");

  return (
    <DropdownMenuContent
      data-slot="prompt-composer-menu"
      side="top"
      align={kind === "sources" ? "start" : "end"}
      sideOffset={8}
      className={cn(
        "min-w-0 rounded-[14px] border-0 p-1 shadow-[0_0_0_1px_var(--border-strong),0_10px_28px_color-mix(in_oklab,black_42%,transparent)]",
        "duration-180 ease-out-quint data-[side=top]:slide-in-from-bottom-0 data-[state=open]:zoom-in-96 data-open:zoom-in-96 motion-reduce:animate-none",
        kind === "sources" ? "w-[min(340px,calc(100vw-32px))]" : "w-44",
      )}
    >
      {children}
    </DropdownMenuContent>
  );
}

const promptComposerMenuItemClass =
  "group/item min-h-9 w-full cursor-pointer gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-[13px]/[18px] transition-colors duration-120 ease-out data-[disabled]:cursor-not-allowed motion-reduce:transition-none [&_svg:not([class*='text-'])]:text-current";

export function PromptComposer({
  variant = "rounded",
  busy = false,
  disabled = false,
  invalid = false,
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  className,
  children,
  ...props
}: PromptComposerProps) {
  const [internalPrompt, setInternalPrompt] = useState(defaultValue);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [expanded, setExpanded] = useState(false);
  const attachmentId = useRef(0);
  const inputId = useId();
  const controlsRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusInputOnReturnRef = useRef(false);
  const keepMenuOpenRef = useRef(false);
  const previousMenuRef = useRef<OpenMenu>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const prompt = value ?? internalPrompt;
  const locked = busy || disabled;
  const canSend = !locked && (prompt.trim().length > 0 || attachments.length > 0);
  const chrome = composerChrome(variant);

  const setPrompt = (nextValue: string) => {
    if (value === undefined) setInternalPrompt(nextValue);
    onValueChange?.(nextValue);
  };

  useLayoutEffect(() => {
    const controls = controlsRef.current;
    const measure = measureRef.current;
    if (!controls || !measure) return;

    const reservedWidth =
      (addRef.current?.offsetWidth ?? chrome.controlSize) +
      (actionsRef.current?.offsetWidth ?? chrome.controlSize) +
      8;
    const inlineInputWidth = controls.clientWidth - reservedWidth;
    const needsFullWidth = prompt.includes("\n") || measure.offsetWidth + 8 > inlineInputWidth;
    if (needsFullWidth !== expanded) setExpanded(needsFullWidth);
  }, [prompt, expanded, chrome.controlSize]);

  useEffect(() => {
    const closed = previousMenuRef.current !== null && openMenu === null;
    previousMenuRef.current = openMenu;
    if (!closed) return;
    focusInputOnReturnRef.current = true;
    const expire = expireOnNextInput(focusInputOnReturnRef);
    return expire;
  }, [openMenu]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    await onSubmit?.(
      prompt.trim(),
      attachments.map((item) => item.file),
    );
    setPrompt("");
    setAttachments([]);
    setOpenMenu(null);
  };

  const context: PromptComposerContextValue = {
    prompt,
    setPrompt,
    attachments,
    addFiles: (files) => {
      setAttachments((current) => [
        ...current,
        ...files.map((file) => {
          attachmentId.current += 1;
          return { id: String(attachmentId.current), file };
        }),
      ]);
    },
    removeAttachment: (id) => {
      setAttachments((current) => current.filter((item) => item.id !== id));
    },
    busy,
    invalid,
    locked,
    canSend,
    expanded,
    openMenu,
    setOpenMenu,
    inputId,
    controlsRef,
    addRef,
    actionsRef,
    inputRef,
    focusInputOnReturnRef,
    keepMenuOpenRef,
    chrome,
  };

  return (
    <PromptComposerContext.Provider value={context}>
      <form
        data-slot="prompt-composer"
        data-variant={variant}
        data-invalid={invalid || undefined}
        className={cn("relative", disabled && "opacity-55", className)}
        aria-busy={busy || undefined}
        aria-disabled={disabled || undefined}
        {...props}
        onSubmit={submit}
      >
        <div
          data-slot="prompt-composer-card"
          className={cn(
            promptComposerCardVariants({
              variant,
              open: expanded || attachments.length > 0,
              invalid,
            }),
          )}
        >
          <span
            ref={measureRef}
            aria-hidden="true"
            className={cn(
              "pointer-events-none invisible absolute whitespace-pre",
              chrome.fieldClass,
            )}
          >
            {prompt}
          </span>

          {attachments.length > 0 ? (
            <div className={cn("flex flex-wrap gap-1.5 pt-0.5", chrome.pill ? "px-1" : "px-0.5")}>
              {attachments.map((item) => (
                <span
                  key={item.id}
                  className={cn(
                    "flex animate-in items-center gap-1.5 bg-muted py-1 pr-1 pl-1.5 text-muted-foreground duration-200 ease-out-quint fade-in-0 zoom-in-95 motion-reduce:animate-none",
                    chrome.chipClass,
                  )}
                >
                  <FileText className="size-3" aria-hidden="true" />
                  <span title={item.file.name} className="max-w-36 truncate text-card-foreground">
                    {item.file.name}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${item.file.name}`}
                    disabled={locked}
                    onClick={() => context.removeAttachment(item.id)}
                    className={cn(
                      "relative grid size-4 place-items-center text-muted-foreground transition-colors after:absolute after:-inset-1 after:content-[''] duration-100 hover:bg-transparent hover:text-card-foreground disabled:opacity-100 dark:hover:bg-transparent",
                      chrome.pill ? "rounded-full" : "rounded",
                    )}
                  >
                    <X className="size-2.5" strokeWidth={2.5} aria-hidden="true" />
                  </Button>
                </span>
              ))}
            </div>
          ) : null}

          <div
            ref={controlsRef}
            className={cn(
              "grid items-end gap-1",
              expanded ? "grid-cols-[auto_minmax(0,1fr)]" : "grid-cols-[auto_minmax(0,1fr)_auto]",
            )}
          >
            {children}
          </div>
        </div>
      </form>
    </PromptComposerContext.Provider>
  );
}

export type PromptComposerAddProps = Omit<ComponentProps<"div">, "children"> & {
  children: ReactNode;
  label?: string;
};

export function PromptComposerAdd({
  children,
  label = "Add attachments and sources",
  className,
  ...props
}: PromptComposerAddProps) {
  const context = usePromptComposer("PromptComposerAdd");
  const open = context.openMenu === "add";

  return (
    <div
      ref={context.addRef}
      data-slot="prompt-composer-add"
      className={cn(
        "relative",
        context.expanded ? "col-start-1 row-start-2" : "col-start-1 row-start-1",
        className,
      )}
      {...props}
    >
      <DropdownMenu modal={false} open={open} onOpenChange={menuOpenChange(context, "add")}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={context.locked}
            onFocus={forwardReturnedFocus(context)}
            className={cn(
              "text-muted-foreground transition-[background-color,color,scale] duration-150 focus-visible:bg-accent active:scale-[0.94] disabled:opacity-100 dark:hover:bg-accent aria-expanded:bg-accent aria-expanded:text-accent-foreground motion-reduce:transition-none motion-reduce:active:scale-100",
              context.chrome.controlClass,
              context.chrome.controlRadiusClass,
            )}
          >
            <span
              className={cn(
                "grid transition-transform duration-160 ease-out-quint",
                open && "rotate-45",
              )}
            >
              <Plus className={context.chrome.iconClass} strokeWidth={2} aria-hidden="true" />
            </span>
          </Button>
        </DropdownMenuTrigger>
        <FloatingMenu kind="sources">{children}</FloatingMenu>
      </DropdownMenu>
    </div>
  );
}

export type PromptComposerAddItemProps = Omit<
  ComponentProps<typeof DropdownMenuItem>,
  "onSelect"
> & {
  icon?: ReactNode;
  description?: ReactNode;
  onSelect?: () => void;
};

function PromptComposerMenuItem({
  icon,
  description,
  children,
  className,
  disabled,
  onSelect,
  onClick,
  ...props
}: PromptComposerAddItemProps) {
  const context = usePromptComposer("PromptComposerAddItem");

  return (
    // `onClick` rather than Radix's `onSelect`: both menu primitives fire it for pointer, Enter,
    // and Space, and Base UI has no `onSelect` item event.
    <DropdownMenuItem
      data-slot="prompt-composer-add-item"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        onSelect?.();
      }}
      disabled={context.locked || disabled}
      className={cn(promptComposerMenuItemClass, className)}
    >
      {icon ? (
        <span className="grid size-5 shrink-0 place-items-center text-muted-foreground transition-colors duration-120 group-data-highlighted/item:text-popover-foreground [&>svg]:size-4">
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate text-[13px]/[18px] font-medium text-popover-foreground">
          {children}
        </span>
        {description ? (
          <span className="min-w-0 truncate text-[12.5px]/[18px] text-subtle-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  );
}

export function PromptComposerAddItem(props: PromptComposerAddItemProps) {
  return <PromptComposerMenuItem {...props} />;
}

export type PromptComposerFileItemProps = Omit<
  ComponentProps<"input">,
  "type" | "children" | "onChange"
> & {
  label?: string;
  description?: string;
};

export function PromptComposerFileItem({
  label = "Add photos & files",
  description = "Upload from your computer",
  multiple = true,
  accept,
  disabled,
  className,
  ...props
}: PromptComposerFileItemProps) {
  const context = usePromptComposer("PromptComposerFileItem");
  const inputRef = useRef<HTMLInputElement>(null);
  const { setOpenMenu, keepMenuOpenRef } = context;

  // The menu stays open while the file picker is up so the input remains mounted.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const close = () => {
      keepMenuOpenRef.current = false;
      setOpenMenu(null);
    };
    input.addEventListener("cancel", close);
    return () => input.removeEventListener("cancel", close);
  }, [setOpenMenu, keepMenuOpenRef]);

  return (
    <>
      <PromptComposerMenuItem
        icon={<Paperclip className="size-4" strokeWidth={1.8} aria-hidden="true" />}
        description={description}
        disabled={disabled}
        onSelect={() => {
          // Hold the menu open (it would close on click) until the picker reports back. If the
          // browser never fires `cancel`, the next key or pointer press releases it.
          keepMenuOpenRef.current = true;
          expireOnNextInput(keepMenuOpenRef);
          inputRef.current?.click();
        }}
      >
        {label}
      </PromptComposerMenuItem>
      <input
        ref={inputRef}
        data-slot="prompt-composer-file-item"
        type="file"
        multiple={multiple}
        accept={accept}
        className={cn("hidden", className)}
        tabIndex={-1}
        aria-label={label}
        {...props}
        disabled={context.locked || disabled}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) context.addFiles(files);
          event.target.value = "";
          keepMenuOpenRef.current = false;
          setOpenMenu(null);
        }}
      />
    </>
  );
}

export type PromptComposerInputProps = Omit<
  ComponentProps<"textarea">,
  "value" | "defaultValue" | "onChange"
>;

export function PromptComposerInput({
  placeholder = "Write a message…",
  "aria-label": ariaLabel = "Prompt",
  className,
  onKeyDown,
  disabled,
  ...props
}: PromptComposerInputProps) {
  const context = usePromptComposer("PromptComposerInput");

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      context.setOpenMenu(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <Textarea
      data-slot="prompt-composer-input"
      {...props}
      ref={context.inputRef}
      id={context.inputId}
      rows={1}
      value={context.prompt}
      disabled={context.locked || disabled}
      aria-label={ariaLabel}
      aria-invalid={context.invalid || undefined}
      placeholder={placeholder}
      onChange={(event) => {
        context.setPrompt(event.target.value);
        context.setOpenMenu(null);
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        "resize-none overflow-y-auto rounded-none border-0 bg-transparent px-1 text-card-foreground caret-card-foreground shadow-none outline-none! field-sizing-content selection:bg-foreground/18 placeholder:text-subtle-foreground focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-100 dark:bg-transparent",
        context.chrome.fieldClass,
        context.chrome.maxFieldHeightClass,
        context.expanded
          ? "col-span-2 col-start-1 row-start-1 w-full"
          : "col-start-2 row-start-1 min-w-0 w-full",
        className,
      )}
    />
  );
}

export type PromptComposerActionsProps = ComponentProps<"div">;

export function PromptComposerActions({
  className,
  children,
  ...props
}: PromptComposerActionsProps) {
  const context = usePromptComposer("PromptComposerActions");

  return (
    <div
      ref={context.actionsRef}
      data-slot="prompt-composer-actions"
      className={cn(
        "flex items-center gap-1",
        context.expanded ? "col-start-2 row-start-2 justify-self-end" : "col-start-3 row-start-1",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type PromptComposerModelSelectProps = Omit<ComponentProps<"div">, "onChange"> & {
  models: readonly PromptComposerModel[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (modelId: string) => void;
  label?: string;
};

export function PromptComposerModelSelect({
  models,
  value,
  defaultValue,
  onValueChange,
  label = "Choose model",
  className,
  ...props
}: PromptComposerModelSelectProps) {
  const context = usePromptComposer("PromptComposerModelSelect");
  const [internalValue, setInternalValue] = useState(defaultValue ?? models[0]?.id ?? "");
  const selectedId = value ?? internalValue;
  const selected = models.find((model) => model.id === selectedId) ?? models[0];
  const open = context.openMenu === "model";

  if (!selected) return null;

  return (
    <div data-slot="prompt-composer-model-select" className={cn("relative", className)} {...props}>
      {models.length > 1 ? (
        <DropdownMenu modal={false} open={open} onOpenChange={menuOpenChange(context, "model")}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${label}: ${selected.label}`}
              disabled={context.locked}
              onFocus={forwardReturnedFocus(context)}
              className={cn(
                "gap-1 px-2 text-muted-foreground transition-colors duration-120 ease-out focus-visible:bg-accent disabled:opacity-100 has-[>svg]:px-2 motion-reduce:transition-none dark:hover:bg-accent aria-expanded:bg-accent aria-expanded:text-accent-foreground",
                context.chrome.controlHeightClass,
                context.chrome.controlRadiusClass,
                context.chrome.modelClass,
              )}
            >
              {selected.label}
              <ChevronDown
                className={cn(
                  "size-3 transition-transform duration-180 ease-out-quint motion-reduce:transition-none",
                  open && "rotate-180",
                )}
                strokeWidth={2.4}
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <FloatingMenu kind="models">
            <DropdownMenuRadioGroup
              value={selected.id}
              onValueChange={(modelId) => {
                if (value === undefined) setInternalValue(modelId);
                onValueChange?.(modelId);
              }}
            >
              {models.map((model) => (
                <DropdownMenuRadioItem
                  key={model.id}
                  value={model.id}
                  className={cn(
                    promptComposerMenuItemClass,
                    "min-h-8 py-0 pl-2 [&>span:first-child]:hidden",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-popover-foreground">
                    {model.label}
                  </span>
                  <Check
                    className={cn(
                      "size-3",
                      model.id === selected.id ? "text-popover-foreground" : "invisible",
                    )}
                    strokeWidth={2.5}
                    aria-hidden="true"
                  />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </FloatingMenu>
        </DropdownMenu>
      ) : (
        <span
          className={cn(
            "flex shrink-0 items-center px-1.5 font-medium text-muted-foreground",
            context.chrome.controlHeightClass,
            context.chrome.modelClass,
          )}
        >
          {selected.label}
        </span>
      )}
    </div>
  );
}

export type PromptComposerSubmitProps = ComponentProps<"button">;

export function PromptComposerSubmit({
  "aria-label": ariaLabel,
  className,
  children,
  disabled,
  ...props
}: PromptComposerSubmitProps) {
  const context = usePromptComposer("PromptComposerSubmit");

  return (
    <Button
      data-slot="prompt-composer-submit"
      size="icon"
      {...props}
      type="submit"
      aria-label={ariaLabel ?? (context.busy ? "Sending prompt" : "Send")}
      disabled={!context.canSend || disabled}
      className={cn(
        "transition-[background-color,color,opacity,scale] duration-140 ease-out-quint enabled:hover:opacity-90 enabled:active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-100 motion-reduce:transition-none motion-reduce:enabled:active:scale-100",
        context.chrome.controlClass,
        context.chrome.controlRadiusClass,
        context.canSend || context.busy
          ? "bg-foreground text-card hover:bg-foreground"
          : "bg-border-strong text-muted-foreground hover:bg-border-strong",
        className,
      )}
    >
      {children ?? (
        <span className="grid [&>*]:[grid-area:1/1]">
          <span
            className={cn(
              "grid place-items-center transition-[opacity,scale,filter] duration-200 ease-out-quint motion-reduce:transition-none",
              context.busy ? "scale-100 blur-none opacity-100" : "scale-50 opacity-0 blur-[2px]",
            )}
          >
            <LoaderCircle
              className={cn(context.chrome.iconClass, "motion-safe:animate-spin")}
              aria-hidden="true"
            />
          </span>
          <span
            className={cn(
              "grid place-items-center transition-[opacity,scale,filter] duration-200 ease-out-quint motion-reduce:transition-none",
              context.busy ? "scale-50 opacity-0 blur-[2px]" : "scale-100 blur-none opacity-100",
            )}
          >
            <ArrowUp className={context.chrome.iconClass} strokeWidth={2.4} aria-hidden="true" />
          </span>
        </span>
      )}
    </Button>
  );
}
