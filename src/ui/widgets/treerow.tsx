// One row of a VS Code tree (the explorer, search results, source control): indent guides, the chevron twistie,
// the icon, the label with its matches, a description, inline actions and the decoration letter ("M", "U") on the
// right. Meant to be rendered by VirtualList with a rowHeight of 22.
//
// Metrics are VS Code's (abstractTree.ts): the twistie is 16px wide after 8px + depth × indent of padding, and the
// indent guide of each ancestor level is a 1px line at 16px + level × indent.

import type { ComponentChildren } from 'preact';
import { ActionBar, type Action } from './actionbar';
import { Highlight } from './highlight';
import { cx } from './util';

export interface TreeRowProps {
  /** 0 for top-level rows. */
  depth: number;
  /** Pixels per level (VS Code's workbench.tree.indent, 8 by default). */
  indent?: number;
  twistie: 'none' | 'collapsed' | 'expanded';
  /** Usually <Icon/>, or a file-type icon. */
  icon?: ComponentChildren;
  label: string;
  /** [start, end) ranges of the label to show as matches. */
  highlights?: Array<[number, number]>;
  /** Muted text after the label (a folder path, a count). */
  description?: string;
  /** A theme variable name such as '--git-modified': colours the label and the badge, as Git decorations do. */
  decorationColor?: string;
  /** The decoration letter shown on the right ("M", "U", "2"). */
  badge?: string;
  /** Struck through (deleted). */
  strike?: boolean;
  /** In italics (a preview, something not saved yet). */
  italic?: boolean;
  /** Dimmed (ignored, cut). */
  faded?: boolean;
  /** Inline actions, shown right-aligned while the row is hovered, focused or selected. */
  actions?: Action[];
  title?: string;
  /** A click on the twistie (only that: it doesn't select or open the row). */
  onTwistie?: () => void;
  /** Shows a spinning icon in place of the chevron while the children load. */
  loading?: boolean;
}

export function TreeRow(p: TreeRowProps) {
  const indent = p.indent ?? 8;
  const guides: ComponentChildren[] = [];
  for (let i = 0; i < p.depth; i++) guides.push(<span class="wg-tree-guide" style={{ left: 16 + i * indent }} />);
  const twistieIcon = p.loading ? 'codicon codicon-loading' : p.twistie !== 'none' ? 'codicon codicon-chevron-down' : '';
  return (
    <div
      class={cx('wg-tree-row', p.decorationColor && 'decorated', p.faded && 'faded', p.italic && 'italic', p.strike && 'strike')}
      title={p.title}
      style={p.decorationColor ? { '--wg-deco': `var(${p.decorationColor})` } : undefined}
    >
      {guides.length > 0 && <div class="wg-tree-guides">{guides}</div>}
      <div
        class={cx('wg-twistie', twistieIcon, p.twistie === 'collapsed' && !p.loading && 'collapsed', p.twistie !== 'none' && 'collapsible')}
        style={{ paddingLeft: 8 + p.depth * indent }}
        aria-hidden="true"
        onClick={
          p.onTwistie && p.twistie !== 'none'
            ? (e) => {
                e.stopPropagation();
                p.onTwistie!();
              }
            : undefined
        }
        onDblClick={p.onTwistie && p.twistie !== 'none' ? (e) => e.stopPropagation() : undefined}
      />
      {p.icon != null && p.icon !== false && <div class="wg-tree-icon">{p.icon}</div>}
      <div class="wg-tree-label-container">
        <Highlight class="wg-tree-label" text={p.label} ranges={p.highlights} />
        {p.description && <span class="wg-tree-desc">{p.description}</span>}
      </div>
      {p.actions && p.actions.length > 0 && <ActionBar class="wg-tree-actions" actions={p.actions} tabbable={false} />}
      {p.badge && <div class="wg-tree-badge">{p.badge}</div>}
    </div>
  );
}
