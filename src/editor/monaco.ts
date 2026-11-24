// The Monaco editor (the editor of Visual Studio Code), set up for web resources: the features that make it feel like
// VS Code, the languages of web resources, VS Code's Dark+ / Light+ / High Contrast colours, and its worker started
// from the code bundled with the manager (no file is ever loaded from anywhere else).
//
// Language services that need large workers (TypeScript, CSS, HTML, JSON) don't fit in a bookmarklet; their place is
// taken by the manager's own providers: formatting (editor/format.ts), syntax checking and Dynamics rules
// (editor/lint.ts) and IntelliSense for the Xrm client API (editor/xrm.ts).

import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/diffEditor/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/wordPartOperations/register';
import 'monaco-editor/features/caretOperations/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/format/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/suggest/register';
// Monaco 0.57's suggest feature only registers inline suggestions: without the controller there is no suggest widget
// and Ctrl+Space does nothing.
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/features/parameterHints/register';
import 'monaco-editor/features/snippet/register';
import 'monaco-editor/features/smartSelect/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/links/register';
import 'monaco-editor/features/stickyScroll/register';
import 'monaco-editor/features/unicodeHighlighter/register';
import 'monaco-editor/features/gotoLine/register';
// Find All References and Peek Definition (Shift+F12, Alt+F12: their peek view), Rename Symbol (F2), Go to Definition
// with Ctrl+Click, the command palette (F1), and Expand Line Selection (Ctrl+L): with editor/jsnav.ts's providers.
import 'monaco-editor/features/referenceSearch/register';
import 'monaco-editor/features/rename/register';
import 'monaco-editor/features/gotoSymbol/register';
import 'monaco-editor/features/quickCommand/register';
import 'monaco-editor/features/lineSelection/register';
import 'monaco-editor/features/quickOutline/register';
import 'monaco-editor/features/documentSymbols/register';
import 'monaco-editor/features/gotoError/register';
import 'monaco-editor/features/codeAction/register';
import 'monaco-editor/features/dnd/register';
import 'monaco-editor/features/readOnlyMessage/register';
import 'monaco-editor/features/toggleTabFocusMode/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/typescript/register';
import { conf as jsConf, language as jsLanguage } from 'monaco-editor/languages/definitions/javascript/javascript';
// The codicon modifiers (spinning icons) are only imported by Monaco's full entry point.
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import editorWorker from 'worker-code:editor';

export { monaco };

// ------------------------------------------------------------------ worker

let workerUrl = '';
/**
 * Whether this page lets the frame start a worker from a blob: address. A worker refused by the page's policy doesn't
 * throw: Monaco would wait for it forever (a comparison never appears). So a tiny worker is tried first, and when it
 * doesn't answer, getWorker throws at once and Monaco runs the same work on the main thread.
 */
export const workersAllowed: Promise<boolean> = new Promise((resolve) => {
  let w: Worker | null = null;
  const done = (ok: boolean) => {
    clearTimeout(t);
    try {
      w?.terminate();
    } catch {
      /* already gone */
    }
    resolve(ok);
  };
  const t = setTimeout(() => done(false), 1500);
  try {
    w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
    w.onmessage = () => done(true);
    w.onerror = () => done(false);
  } catch {
    done(false);
  }
});
let blobWorkers = false;
void workersAllowed.then((ok) => (blobWorkers = ok));

(globalThis as any).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    // One worker kind is bundled (the editor's own: diffs, word-based suggestions, links).
    if (!blobWorkers) throw new Error('Workers are not allowed here: the editor works on the main thread.');
    if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([editorWorker], { type: 'text/javascript' }));
    return new Worker(workerUrl, { name: label });
  },
};

// ------------------------------------------------------------------ JavaScript, coloured as in VS Code

/** Keywords VS Code colours as control flow (purple in Dark+). */
const CONTROL = ['break', 'case', 'catch', 'continue', 'default', 'do', 'else', 'export', 'finally', 'for', 'from', 'if', 'import', 'return', 'switch', 'throw', 'try', 'while', 'with', 'yield', 'await', 'as'];

/** Built-in classes and namespaces VS Code colours as types (teal in Dark+): Object.keys, JSON.parse, new Date(). */
const BUILTIN_TYPES = [
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'Float32Array', 'Float64Array', 'Function', 'Int8Array', 'Int16Array',
  'Int32Array', 'Intl', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'String',
  'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'WeakMap', 'WeakRef', 'WeakSet',
];

/**
 * Monaco's JavaScript tokenizer, with what VS Code's grammar adds: control-flow keywords, function names (an
 * identifier followed by an opening parenthesis), and variables and properties in their own colour. Monaco colours
 * every name that starts with a capital as a type; VS Code does that only for classes (after new, extends,
 * instanceof, class) and the built-in ones, and colours Xrm.Page, Contoso.Account = … as variables and MyFunc() as a
 * function, which is how most Dynamics code is written.
 */
function vscodeJs(): monaco.languages.IMonarchLanguage {
  const lang = structuredClone(jsLanguage) as any;
  lang.controlKeywords = CONTROL;
  lang.builtinTypes = BUILTIN_TYPES;
  lang.keywords = (lang.keywords as string[]).filter((k) => !CONTROL.includes(k)).concat(['as']);
  const common = lang.tokenizer.common as any[];
  const id = common.findIndex((r) => Array.isArray(r) && String(r[0]) === String(/#?[a-z_$][\w$]*/));
  const cases = { '@controlKeywords': 'keyword.control', '@keywords': 'keyword', '@default': 'identifier' };
  const call = [/#?[a-z_$][\w$]*(?=\s*(\?\.)?\()/, { cases: { '@controlKeywords': 'keyword.control', '@keywords': 'keyword', '@default': 'function' } }];
  // A class name after the keyword that makes it one (first: the keyword rule below would take the keyword alone).
  const classRef = [/(new|extends|instanceof|class)(\s+)([A-Z][\w$]*)/, ['keyword', '', 'type.identifier']];
  if (id >= 0) common.splice(id, 1, classRef, call, [/#?[a-z_$][\w$]*/, { cases }]);
  else common.unshift(classRef, call, [/#?[a-z_$][\w$]*/, { cases }]);
  const upper = common.findIndex((r) => Array.isArray(r) && String(r[0]) === String(/[A-Z][\w\$]*/));
  const capitals = [
    [/[A-Z][\w$]*(?=\s*(\?\.)?\()/, { cases: { '@builtinTypes': 'type.identifier', '@default': 'function' } }],
    [/[A-Z][\w$]*/, { cases: { '@builtinTypes': 'type.identifier', '@default': 'identifier' } }],
  ];
  if (upper >= 0) common.splice(upper, 1, ...capitals);
  return lang;
}

monaco.languages.register({ id: 'javascript', extensions: ['.js', '.mjs', '.cjs'], aliases: ['JavaScript', 'javascript', 'js'], mimetypes: ['text/javascript'] });
monaco.languages.setLanguageConfiguration('javascript', jsConf);
monaco.languages.setMonarchTokensProvider('javascript', vscodeJs());

// ------------------------------------------------------------------ JSON

// JSON web resources (stored as Script or Data, told apart by their names: format.ts languageOf). Monaco's JSON
// support is a language-service worker that doesn't fit; colours come from this small tokenizer, checks and formatting
// from format.ts. Keys and values are told apart as VS Code does (a string followed by a colon is a key).
monaco.languages.register({ id: 'json', extensions: ['.json'], aliases: ['JSON', 'json'], mimetypes: ['application/json'] });
monaco.languages.setLanguageConfiguration('json', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['string'] },
    { open: '[', close: ']', notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
});
monaco.languages.setMonarchTokensProvider('json', {
  defaultToken: '',
  tokenPostfix: '.json',
  brackets: [
    { open: '{', close: '}', token: 'delimiter.bracket' },
    { open: '[', close: ']', token: 'delimiter.array' },
  ],
  tokenizer: {
    root: [
      [/[ \t\r\n]+/, ''],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
      [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string.value', '@string'],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/(?:true|false|null)\b/, 'keyword'],
      [/[{}[\]]/, '@brackets'],
      [/[,:]/, 'delimiter'],
      [/./, 'invalid'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
    string: [
      [/[^\\"]+/, 'string.value'],
      [/\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string.value', '@pop'],
    ],
  },
});

// ------------------------------------------------------------------ themes

const darkRules: monaco.editor.ITokenThemeRule[] = [
  { token: 'keyword.control', foreground: 'C586C0' },
  { token: 'keyword', foreground: '569CD6' },
  { token: 'function', foreground: 'DCDCAA' },
  { token: 'identifier.js', foreground: '9CDCFE' },
  { token: 'identifier.ts', foreground: '9CDCFE' },
  { token: 'type.identifier', foreground: '4EC9B0' },
  { token: 'string.escape', foreground: 'D7BA7D' },
  { token: 'regexp', foreground: 'D16969' },
  // Dark+'s green for every comment (Monaco's own dark theme has an older one for line comments).
  { token: 'comment', foreground: '6A9955' },
  { token: 'comment.doc', foreground: '6A9955' },
  { token: 'keyword.json', foreground: '569CD6' },
];
const lightRules: monaco.editor.ITokenThemeRule[] = [
  { token: 'keyword.control', foreground: 'AF00DB' },
  { token: 'keyword', foreground: '0000FF' },
  { token: 'function', foreground: '795E26' },
  { token: 'identifier.js', foreground: '001080' },
  { token: 'identifier.ts', foreground: '001080' },
  { token: 'type.identifier', foreground: '267F99' },
  { token: 'string.escape', foreground: 'EE0000' },
  { token: 'regexp', foreground: '811F3F' },
  { token: 'comment.doc', foreground: '008000' },
  // Light+ colours JSON names blue and string values red (Monaco's own light theme has them the other way round).
  { token: 'string.key.json', foreground: '0451A5' },
  { token: 'string.value.json', foreground: 'A31515' },
  { token: 'keyword.json', foreground: '0000FF' },
];
const hcRules: monaco.editor.ITokenThemeRule[] = [
  { token: 'keyword.control', foreground: 'C586C0' },
  { token: 'function', foreground: 'DCDCAA' },
  { token: 'identifier.js', foreground: '9CDCFE' },
  { token: 'identifier.ts', foreground: '9CDCFE' },
  { token: 'type.identifier', foreground: '4EC9B0' },
];

monaco.editor.defineTheme('wrm-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: darkRules,
  colors: {
    'editor.background': '#1e1e1e',
    'editorBracketHighlight.foreground1': '#ffd700',
    'editorBracketHighlight.foreground2': '#da70d6',
    'editorBracketHighlight.foreground3': '#179fff',
    'editorStickyScroll.background': '#1e1e1e',
    'editorGutter.modifiedBackground': '#1b81a8',
    'editorGutter.addedBackground': '#487e02',
    'editorGutter.deletedBackground': '#f14c4c',
  },
});
monaco.editor.defineTheme('wrm-light', {
  base: 'vs',
  inherit: true,
  rules: lightRules,
  colors: {
    'editorBracketHighlight.foreground1': '#0431fa',
    'editorBracketHighlight.foreground2': '#319331',
    'editorBracketHighlight.foreground3': '#7b3814',
    'editorGutter.modifiedBackground': '#2090d3',
    'editorGutter.addedBackground': '#48985d',
    'editorGutter.deletedBackground': '#e51400',
  },
});
monaco.editor.defineTheme('wrm-hc', { base: 'hc-black', inherit: true, rules: hcRules, colors: {} });

export type Theme = 'dark' | 'light' | 'hc';
export const setEditorTheme = (t: Theme) => monaco.editor.setTheme(t === 'light' ? 'wrm-light' : t === 'hc' ? 'wrm-hc' : 'wrm-dark');

// ------------------------------------------------------------------ models

/** The model URI of a web resource: wr:/<name> for the server's text, with a query telling the versions apart. */
export function wrUri(name: string, version: 'draft' | 'server' | 'published' | 'base' | 'theirs' | 'local' | string = 'draft'): monaco.Uri {
  return monaco.Uri.from({ scheme: 'wr', path: '/' + name, query: version === 'draft' ? '' : version });
}

/** A model for text, reusing one with the same URI. */
export function modelFor(uri: monaco.Uri, text: string, language: string): monaco.editor.ITextModel {
  const m = monaco.editor.getModel(uri);
  if (m) {
    if (m.getLanguageId() !== language) monaco.editor.setModelLanguage(m, language);
    // A model holds one kind of line ending: text that differs only by them (a file that mixes them) is the same.
    const value = m.getValue();
    if (value !== text && value !== text.replace(/\r\n|\r|\n/g, m.getEOL())) m.setValue(text);
    return m;
  }
  return monaco.editor.createModel(text, language, uri);
}

/** Options every code editor of the manager starts with (settings change them later). */
export const baseEditorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 14,
  lineHeight: 19,
  minimap: { enabled: true },
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: 'active', indentation: true },
  renderWhitespace: 'selection',
  smoothScrolling: true,
  cursorBlinking: 'blink',
  mouseWheelZoom: true,
  stickyScroll: { enabled: true },
  // Not past the end: a text replaced by a shorter one (their version taken, changes discarded) would otherwise stay
  // scrolled down to its last lines.
  scrollBeyondLastLine: false,
  // F12 goes to the definition, as in VS Code, even when more than one is found (the first, the script's own); Alt+F12
  // peeks at them.
  gotoLocation: { multipleDefinitions: 'goto', multipleDeclarations: 'goto', multipleTypeDefinitions: 'goto', multipleImplementations: 'goto' },
  fixedOverflowWidgets: true,
  tabSize: 4,
  insertSpaces: true,
  detectIndentation: true,
  wordWrap: 'off',
  'semanticHighlighting.enabled': false,
  unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true },
  quickSuggestions: { other: true, comments: false, strings: true },
};
