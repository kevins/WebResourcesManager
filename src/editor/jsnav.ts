// Go to Definition (F12, Ctrl+Click), Peek Definition (Alt+F12), Find All References (Shift+F12) and Rename Symbol
// (F2) for JavaScript. VS Code gets them from the TypeScript language service, which doesn't fit in the bookmarklet;
// here they come from acorn's syntax tree (editor/jsscope.ts), and from the outline (editor/outline.ts), which follows
// more ways of making a namespace. A local name is found in its own script; a global name or a namespace member
// (Contoso.Account.onLoad) in every script the manager knows: the form's scripts (read when first needed) and those
// opened. Global names are never renamed: a form's event handlers, and scripts the manager doesn't know, use them too.

import { analyseText, definitionSpans, localSpans, referenceSpans, renameEdits, renameTarget, targetAt, textDefinitionSpans, textReferenceSpans, type Analysis, type Span } from './jsscope';
import { monaco } from './monaco';
import { outlineOf } from './outline';

const cache = new WeakMap<monaco.editor.ITextModel, { version: number; a: Analysis | null }>();

/** A model's analysis for its current text (null when it doesn't parse: in the middle of an edit). */
function analyse(model: monaco.editor.ITextModel): Analysis | null {
  const version = model.getVersionId();
  const c = cache.get(model);
  if (c?.version === version) return c.a;
  const a = analyseText(model.getValue());
  cache.set(model, { version, a });
  return a;
}

const rangeOf = (model: monaco.editor.ITextModel, s: Span) => {
  const a = model.getPositionAt(s.start);
  const b = model.getPositionAt(s.end);
  return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
};

/** The paths the outline gives a script (Contoso > Account > onLoad is Contoso.Account.onLoad), with their names' ranges. */
function outlinePaths(model: monaco.editor.ITextModel): Array<{ path: string; range: monaco.IRange }> {
  const out: Array<{ path: string; range: monaco.IRange }> = [];
  const walk = (list: monaco.languages.DocumentSymbol[], base: string) => {
    for (const s of list) {
      const path = base ? `${base}.${s.name}` : s.name;
      out.push({ path, range: s.selectionRange });
      if (s.children?.length) walk(s.children, path);
    }
  };
  walk(outlineOf(model), '');
  return out;
}

const sameRange = (a: monaco.IRange, b: monaco.IRange) => a.startLineNumber === b.startLineNumber && a.startColumn === b.startColumn && a.endLineNumber === b.endLineNumber && a.endColumn === b.endColumn;

function add(out: monaco.languages.Location[], uri: monaco.Uri, range: monaco.IRange): void {
  if (!out.some((l) => l.uri.toString() === uri.toString() && sameRange(l.range, range))) out.push({ uri, range });
}

/** Where a global name or path gets its value, in the models given (the one asked about first). */
function definitionsOf(key: string, models: monaco.editor.ITextModel[]): monaco.languages.Location[] {
  const out: monaco.languages.Location[] = [];
  for (const m of models) {
    const a = analyse(m);
    if (a) for (const s of definitionSpans(key, a, m.getValue())) add(out, m.uri, rangeOf(m, s));
  }
  // The outline follows more ways of making a namespace: asked only when the syntax tree found nothing (asked always,
  // it gave the same definition a second time, with another range, and F12 showed a peek instead of going there).
  if (!out.length) for (const m of models) for (const o of outlinePaths(m)) if (o.path === key) add(out, m.uri, o.range);
  return out;
}

function textDefinitions(word: string, models: monaco.editor.ITextModel[]): monaco.languages.Location[] {
  const out: monaco.languages.Location[] = [];
  for (const m of models) for (const s of textDefinitionSpans(word, m.getValue())) add(out, m.uri, rangeOf(m, s));
  return out;
}

export interface NavigationOptions {
  /** The other JavaScript models to look in (the form's other scripts, read when first needed; the scripts opened). */
  models(): Promise<monaco.editor.ITextModel[]>;
}

/** Registers Go to Definition, Find All References and Rename Symbol for JavaScript. */
export function registerJsNavigation(o: NavigationOptions): monaco.IDisposable {
  /** The model asked about first, then the others the manager knows. */
  const all = async (model: monaco.editor.ITextModel) => {
    let list: monaco.editor.ITextModel[] = [];
    try {
      list = await o.models();
    } catch {
      list = [];
    }
    return [model, ...list.filter((m) => m !== model && !m.isDisposed() && m.getLanguageId() === 'javascript')];
  };
  const disposables = [
    monaco.languages.registerDefinitionProvider('javascript', {
      async provideDefinition(model, position) {
        const a = analyse(model);
        const word = model.getWordAtPosition(position)?.word;
        // In the middle of an edit (the script doesn't parse): by the name's definitions as text.
        if (!a) return word ? textDefinitions(word, await all(model)) : null;
        const t = targetAt(a, model.getOffsetAt(position));
        if (!t) return null;
        if (t.kind === 'local') return [{ uri: model.uri, range: rangeOf(model, t.decl.id) }];
        // A member of a local variable is only in this script.
        const found = definitionsOf(t.key, t.local ? [model] : await all(model));
        if (found.length || t.local) return found;
        // A namespace made in a way not followed: by its last name, as text.
        const last = t.key.split('.').pop() || '';
        return t.key.includes('.') ? textDefinitions(last, await all(model)) : null;
      },
    }),
    monaco.languages.registerReferenceProvider('javascript', {
      async provideReferences(model, position) {
        const a = analyse(model);
        if (!a) {
          // In the middle of an edit (the script doesn't parse): the name's occurrences as text.
          const word = model.getWordAtPosition(position)?.word;
          if (!word) return null;
          const out: monaco.languages.Location[] = [];
          for (const m of await all(model)) for (const s of textReferenceSpans(word, m.getValue())) add(out, m.uri, rangeOf(m, s));
          return out;
        }
        const t = targetAt(a, model.getOffsetAt(position));
        if (!t) return null;
        if (t.kind === 'local') return localSpans(t.decl, a).map((s) => ({ uri: model.uri, range: rangeOf(model, s) }));
        const out: monaco.languages.Location[] = [];
        for (const m of t.local ? [model] : await all(model)) {
          const b = analyse(m);
          if (b) for (const s of referenceSpans(t.key, b)) add(out, m.uri, rangeOf(m, s));
        }
        return out;
      },
    }),
    monaco.languages.registerRenameProvider('javascript', {
      resolveRenameLocation(model, position) {
        const r = renameTarget(analyse(model), model.getOffsetAt(position));
        const range = r.span ? rangeOf(model, r.span) : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        return 'reason' in r ? { range, text: '', rejectReason: r.reason } : { range, text: r.name };
      },
      provideRenameEdits(model, position, newName) {
        const r = renameEdits(analyse(model), model.getOffsetAt(position), newName);
        if (typeof r === 'string') return { edits: [], rejectReason: r };
        const versionId = model.getVersionId();
        return { edits: r.map((e) => ({ resource: model.uri, versionId, textEdit: { range: rangeOf(model, e), text: e.text } })) };
      },
    }),
  ];
  return { dispose: () => disposables.forEach((d) => d.dispose()) };
}
