// Format Document (Shift+Alt+F, and in the editor's right-click menu) and Format Selection (Ctrl+K Ctrl+F) with the
// formatters of editor/format.ts: js-beautify for JavaScript, CSS and HTML, and the manager's own for XML and JSON.
// The result is an edit like any other: Ctrl+Z undoes it, and nothing is saved until Save.

import { canFormat, formatText } from './format';
import { monaco } from './monaco';

const LANGUAGES = ['javascript', 'css', 'html', 'xml', 'json'].filter(canFormat);
/** Languages whose fragments format on their own (a few lines of a script or a stylesheet). */
const FRAGMENTS = new Set(['javascript', 'css']);

const options = (model: monaco.editor.ITextModel, o: monaco.languages.FormattingOptions) => ({
  tabSize: o.tabSize,
  insertSpaces: o.insertSpaces,
  eol: (model.getEOL() === '\r\n' ? '\r\n' : '\n') as '\r\n' | '\n',
});

/** The text formatted, or null when it can't be (a syntax error the formatter refuses). */
function formatted(lang: string, text: string, o: ReturnType<typeof options>): string | null {
  try {
    return formatText(lang, text, o);
  } catch {
    return null;
  }
}

export function registerFormatting(): monaco.IDisposable {
  const ds: monaco.IDisposable[] = [];
  for (const lang of LANGUAGES) {
    ds.push(
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        displayName: 'Web resource formatter',
        provideDocumentFormattingEdits(model, o) {
          const text = model.getValue();
          const out = formatted(lang, text, options(model, o));
          return out === null || out === text ? [] : [{ range: model.getFullModelRange(), text: out }];
        },
      }),
    );
    if (FRAGMENTS.has(lang))
      ds.push(
        monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
          displayName: 'Web resource formatter',
          provideDocumentRangeFormattingEdits(model, range, o) {
            // Whole lines, formatted on their own, then indented as the first one was.
            const lines = new monaco.Range(range.startLineNumber, 1, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber));
            const text = model.getValueInRange(lines);
            if (!text.trim()) return [];
            const indent = /^[ \t]*/.exec(model.getLineContent(range.startLineNumber))?.[0] ?? '';
            const o2 = options(model, o);
            const out = formatted(lang, text, o2);
            if (out === null) return [];
            const body = out
              .replace(/\s+$/, '')
              .split(/\r\n|\n/)
              .map((l) => (l ? indent + l : l))
              .join(o2.eol);
            return body === text ? [] : [{ range: lines, text: body }];
          },
        }),
      );
  }
  return { dispose: () => ds.forEach((d) => d.dispose()) };
}
