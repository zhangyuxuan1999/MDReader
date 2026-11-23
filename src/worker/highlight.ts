// src/worker/highlight.ts — highlight.js (common languages) behind the size cap of SPEC 4.4.
//
// The languages are exactly those of highlight.js/lib/common, in its order. They are registered by
// registerLanguages() (the worker calls it at start, as importing lib/common did) or on first use, and not
// by importing lib/common: that module is declared side-effectful, so md.ts importing this file would pull
// highlight.js into every bundle that imports md.ts — the main thread's fidelity gate (CONTRACT §11, U12)
// builds md.ts's configuration without a highlighter, and with nothing at module level here an unused
// highlightCode takes highlight.js out of that bundle.
import hljs from 'highlight.js/lib/core';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import ruby from 'highlight.js/lib/languages/ruby';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import perl from 'highlight.js/lib/languages/perl';
import objectivec from 'highlight.js/lib/languages/objectivec';
import php from 'highlight.js/lib/languages/php';
import phpTemplate from 'highlight.js/lib/languages/php-template';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import pythonRepl from 'highlight.js/lib/languages/python-repl';
import r from 'highlight.js/lib/languages/r';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import yaml from 'highlight.js/lib/languages/yaml';
import typescript from 'highlight.js/lib/languages/typescript';
import vbnet from 'highlight.js/lib/languages/vbnet';
import wasm from 'highlight.js/lib/languages/wasm';

/** highlight.js/lib/common's languages (highlight.js 11), same names, same order. */
const COMMON = [
  ['xml', xml], ['bash', bash], ['c', c], ['cpp', cpp], ['csharp', csharp], ['css', css], ['markdown', markdown],
  ['diff', diff], ['ruby', ruby], ['go', go], ['graphql', graphql], ['ini', ini], ['java', java],
  ['javascript', javascript], ['json', json], ['kotlin', kotlin], ['less', less], ['lua', lua],
  ['makefile', makefile], ['perl', perl], ['objectivec', objectivec], ['php', php], ['php-template', phpTemplate],
  ['plaintext', plaintext], ['python', python], ['python-repl', pythonRepl], ['r', r], ['rust', rust],
  ['scss', scss], ['shell', shell], ['sql', sql], ['swift', swift], ['yaml', yaml], ['typescript', typescript],
  ['vbnet', vbnet], ['wasm', wasm],
] as const;

let registered = false;

/** Registers the common languages once. */
export function registerLanguages(): void {
  if (registered) return;
  registered = true;
  for (const [name, lang] of COMMON) hljs.registerLanguage(name, lang);
}

/** Returns highlighted HTML, or null when the language is unknown / the code exceeds the cap. */
export function highlightCode(code: string, lang: string, maxChars: number): string | null {
  registerLanguages();
  if (code.length > maxChars || lang === '' || !hljs.getLanguage(lang)) return null;
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}
