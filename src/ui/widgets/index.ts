// The widget kit of the workbench: VS Code's controls and pop-ups, styled by widgets.css with the theme's variables.

import './widgets.css';

export { Icon, type IconProps } from './icon';
export { ActionBar, type Action, type ActionBarProps } from './actionbar';
export { VirtualList, type VirtualListProps, type RowState } from './list';
export { TreeRow, type TreeRowProps } from './treerow';
export { Highlight, type HighlightProps } from './highlight';
export { KeybindingLabel, type KeybindingLabelProps } from './keybinding';
export { fuzzyScore, fuzzyMatch, toRanges, type FuzzyMatch } from './fuzzy';
export { showMenu, closeMenu, menuOpen, type MenuItem, type ShowMenuOptions } from './menu';
export {
  quickPick,
  inputBox,
  closeQuickInput,
  quickInputOpen,
  quickSeparator,
  type QuickItem,
  type QuickPickOptions,
  type InputBoxOptions,
} from './quickinput';
export { confirmDialog, modalOpen, type ConfirmDialogOptions, type DialogButton, type DialogResult } from './dialog';
export {
  notify,
  notifications,
  toasts,
  clearAll,
  showCenter,
  type Note,
  type NoteOptions,
  type NoteAction,
  type NoteHandle,
  type Severity,
} from './notify';
export { Sash, type SashProps } from './sash';
export {
  SearchInput,
  TextInput,
  Checkbox,
  Select,
  Button,
  Badge,
  ProgressBar,
  type SearchInputProps,
  type InputToggle,
  type TextInputProps,
  type CheckboxProps,
  type SelectProps,
  type ButtonProps,
  type BadgeProps,
  type ProgressBarProps,
} from './inputs';
export { Layers } from './layers';
export { installCodiconStyles } from './codicons';
export { cx } from './util';
