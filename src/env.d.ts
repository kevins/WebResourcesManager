// Build-time constants injected by tools/build.mjs.
declare const __VERSION__: string;
declare const __DEV__: boolean;
declare const __BUILD__: string;

// Stylesheets imported for their side effect are collected into the one stylesheet the app puts in its document.
declare module '*.css';

// `import code from 'worker-code:editor'`: a worker's bundled code, as text (tools/build.mjs).
declare module 'worker-code:*' {
  const code: string;
  export default code;
}

// js-beautify ships without types; only what editor/format.ts calls.
declare module 'js-beautify' {
  type Options = Record<string, unknown>;
  const beautify: { js(s: string, o?: Options): string; css(s: string, o?: Options): string; html(s: string, o?: Options): string };
  export default beautify;
}

// Monaco's JavaScript definition (the tokenizer the manager extends); the module ships without types.
declare module 'monaco-editor/languages/definitions/javascript/javascript' {
  import type * as monaco from 'monaco-editor/editor';
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}
