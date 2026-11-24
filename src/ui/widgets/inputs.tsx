// VS Code's form controls: the find input with its Aa / ab / .* toggles, text inputs, checkboxes, drop-downs,
// buttons, count badges and the thin progress bar of views.

import type { ComponentChildren, JSX, Ref } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { cx } from './util';

export interface InputToggle {
  /** Codicon name: case-sensitive, whole-word, regex, preserve-case… */
  icon: string;
  title: string;
  checked: boolean;
  onToggle: () => void;
}

export interface SearchInputProps {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  /** Toggle buttons inside the box, on the right. */
  toggles?: InputToggle[];
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Shown in a red box under the input (and the input gets a red border); '' or undefined for none. */
  error?: string;
  autoFocus?: boolean;
  class?: string;
  ariaLabel?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/** Focuses the input once, after it is in the document. */
function useAutoFocus(ref: { current: HTMLInputElement | null }, on: boolean | undefined) {
  useLayoutEffect(() => {
    if (on) ref.current?.focus({ preventScroll: true });
  }, []);
}

function setRef<T>(r: Ref<T> | undefined, v: T | null) {
  if (typeof r === 'function') r(v);
  else if (r) r.current = v;
}

export function SearchInput(p: SearchInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  useAutoFocus(ref, p.autoFocus);
  const toggles = p.toggles ?? [];
  return (
    <div class={cx('wg-inputbox-container', p.class)}>
      <div class={cx('wg-inputbox', 'wg-findinput', p.error && 'error')}>
        <input
          ref={(el) => {
            ref.current = el;
            setRef(p.inputRef, el);
          }}
          class="wg-input"
          type="text"
          value={p.value}
          placeholder={p.placeholder}
          aria-label={p.ariaLabel ?? p.placeholder}
          aria-invalid={p.error ? true : undefined}
          spellcheck={false}
          autocomplete="off"
          style={toggles.length ? { paddingRight: 4 + toggles.length * 22 } : undefined}
          onInput={(e) => p.onInput(e.currentTarget.value)}
          onKeyDown={p.onKeyDown}
        />
        {toggles.length > 0 && (
          <div class="wg-findinput-controls">
            {toggles.map((t) => (
              <button
                type="button"
                key={t.icon}
                class={cx('wg-toggle', t.checked && 'checked')}
                title={t.title}
                aria-label={t.title}
                role="checkbox"
                aria-checked={t.checked}
                // The input keeps the focus, so typing goes on.
                onMouseDown={(e) => e.preventDefault()}
                onClick={t.onToggle}
              >
                <i class={cx('codicon', `codicon-${t.icon}`)} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>
      {p.error && (
        <div class="wg-input-message error" role="alert">
          {p.error}
        </div>
      )}
    </div>
  );
}

export interface TextInputProps {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  error?: string;
  autoFocus?: boolean;
  /** Selects the whole value when focused at the start (with autoFocus). */
  selectAll?: boolean;
  type?: 'text' | 'password' | 'search' | 'number' | 'url';
  title?: string;
  disabled?: boolean;
  ariaLabel?: string;
  class?: string;
  inputRef?: Ref<HTMLInputElement>;
}

export function TextInput(p: TextInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!p.autoFocus) return;
    ref.current?.focus({ preventScroll: true });
    if (p.selectAll) ref.current?.select();
  }, []);
  return (
    <div class={cx('wg-inputbox-container', p.class)}>
      <div class={cx('wg-inputbox', p.error && 'error', p.disabled && 'disabled')}>
        <input
          ref={(el) => {
            ref.current = el;
            setRef(p.inputRef, el);
          }}
          class="wg-input"
          type={p.type ?? 'text'}
          value={p.value}
          placeholder={p.placeholder}
          title={p.title}
          disabled={p.disabled}
          aria-label={p.ariaLabel ?? p.placeholder ?? p.title}
          aria-invalid={p.error ? true : undefined}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => p.onInput(e.currentTarget.value)}
          onKeyDown={p.onKeyDown}
          onBlur={p.onBlur}
        />
      </div>
      {p.error && (
        <div class="wg-input-message error" role="alert">
          {p.error}
        </div>
      )}
    </div>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ComponentChildren;
  title?: string;
  disabled?: boolean;
  class?: string;
}

/** VS Code's checkbox: an 18px box with a check mark, its label clickable too. Space toggles it. */
export function Checkbox({ checked, onChange, label, title, disabled, class: cls }: CheckboxProps) {
  const toggle = () => {
    if (!disabled) onChange(!checked);
  };
  return (
    <div class={cx('wg-checkbox-row', disabled && 'disabled', cls)} title={title} onClick={toggle}>
      <div
        role="checkbox"
        tabIndex={disabled ? -1 : 0}
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-label={typeof label === 'string' ? label : title}
        class={cx('wg-checkbox', checked && 'checked')}
        onKeyDown={(e) => {
          if (e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {checked && <i class="codicon codicon-check" aria-hidden="true" />}
      </div>
      {label != null && <span class="wg-checkbox-label">{label}</span>}
    </div>
  );
}

export interface SelectProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  title?: string;
  disabled?: boolean;
  ariaLabel?: string;
  class?: string;
}

export function Select({ value, options, onChange, title, disabled, ariaLabel, class: cls }: SelectProps) {
  return (
    <div class={cx('wg-select', disabled && 'disabled', cls)}>
      <select value={value} title={title} disabled={disabled} aria-label={ariaLabel ?? title} onChange={(e) => onChange(e.currentTarget.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <i class="codicon codicon-chevron-down" aria-hidden="true" />
    </div>
  );
}

export interface ButtonProps {
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  onClick: (e: MouseEvent) => void;
  children: ComponentChildren;
  title?: string;
  class?: string;
  autoFocus?: boolean;
}

export function Button({ kind = 'primary', disabled, onClick, children, title, class: cls, autoFocus }: ButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <button ref={ref} type="button" class={cx('wg-button', `wg-button-${kind}`, cls)} title={title} disabled={disabled} onClick={disabled ? undefined : onClick}>
      {children}
    </button>
  );
}

export interface BadgeProps {
  count?: number;
  text?: string;
  title?: string;
  /** The activity bar's accent colour instead of the grey of view badges. */
  accent?: boolean;
  class?: string;
}

/** A count badge (the number on a view or tab); nothing when there is no count or text. */
export function Badge({ count, text, title, accent, class: cls }: BadgeProps) {
  const t = text ?? (count !== undefined && count !== null ? String(count) : '');
  if (!t) return null;
  return (
    <span class={cx('wg-badge', accent && 'accent', t.length > 3 && 'long', cls)} title={title}>
      {t}
    </span>
  );
}

export interface ProgressBarProps {
  active: boolean;
  /** 0..100 for a known amount; without it the bar runs back and forth (indeterminate). */
  value?: number;
  class?: string;
  style?: JSX.CSSProperties;
}

/** The 2px progress bar VS Code shows at the top of a view while it works. */
export function ProgressBar({ active, value, class: cls, style }: ProgressBarProps) {
  const discrete = typeof value === 'number';
  return (
    <div
      class={cx('wg-progress', active && 'active', discrete ? 'discrete' : 'infinite', cls)}
      style={style}
      role="progressbar"
      aria-hidden={active ? undefined : true}
      aria-valuemin={discrete ? 0 : undefined}
      aria-valuemax={discrete ? 100 : undefined}
      aria-valuenow={discrete ? Math.round(value!) : undefined}
    >
      {active && <div class="wg-progress-bit" style={discrete ? { width: `${Math.max(0, Math.min(100, value!))}%` } : undefined} />}
    </div>
  );
}
