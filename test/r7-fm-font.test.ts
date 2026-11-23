// @vitest-environment jsdom
// test/r7-fm-font.test.ts — fix-merge (0.2.1, fix round 7): P2 (CONTRACT §11, Round-7 decisions; VF-2 of
// docs/FINDINGS-0.2.0-r6.md) at the unit level. The session DOMs below are what Chromium left after the session's bold /
// italic command (⌘B / ⌘I) on part of, the whole of, or across spans styled with the CSS font shorthand (with and without a
// weight and a style word, a line height, a colour, a longhand after the shorthand, inside bold or italic text) and on
// longhand spans, captured in the app with bench/verify/r7-fm-probe.mjs (stamps included); `want` is what the app wrote
// after Esc there (checked against the re-rendered block by bench/verify/r7-fm-font.mjs). The rule: the shorthand's own
// word is edited (taken out, or set to what the element now inherits), never expanded into longhands; a property the
// command did not change for an element (its recorded value is what it now inherits) leaves the record alone.
// jsdom's CSSOM does not split the font shorthand, so this is the serializer's textual edit; Chromium proves it in the
// browser script. pre-r7's serializer (the released 0.2.0) is asked too where Chromium showed it wrong.
// Run: perl -e 'alarm 60; exec @ARGV' npx vitest run test/r7-fm-font.test.ts
import { describe, expect, it } from "vitest";
import { BlockKind } from "../src/shared/types";
import { serializeBlock, sourceStyleHints } from "../src/preview/serialize";
import * as pre7 from "./fixtures/src-0.2.0/preview/serialize";

const FIXTURES: Array<{ name: string; src: string; html: string; want: string }> = [
 {
  "name": "sh-unbold-part",
  "src": "前文 <span style=\"font: bold 16px serif\">简写粗体 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">简写</span><span style=\"font: bold 16px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">粗体 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 16px serif\">简写</span><span style=\"font: bold 16px serif\">粗体 here</span> 后面 words"
 },
 {
  "name": "sh-unbold-whole",
  "src": "前文 <span style=\"font: bold 16px serif\">简写粗体</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">简写粗体</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 16px serif\">简写粗体</span> 后面 words"
 },
 {
  "name": "sh-unitalic-part",
  "src": "前文 <span style=\"font: italic 15px serif\">简写斜体 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-weight: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: italic 15px serif&quot;}\">简写</span><span style=\"font: italic 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: italic 15px serif&quot;}\">斜体 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 15px serif\">简写</span><span style=\"font: italic 15px serif\">斜体 here</span> 后面 words"
 },
 {
  "name": "sh-bold-plain-part",
  "src": "前文 <span style=\"font: 15px serif\">简写正常 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\"><b>简写</b></span><span style=\"font: 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">正常 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 15px serif\">**简写**</span><span style=\"font: 15px serif\">正常 here</span> 后面 words"
 },
 {
  "name": "sh-italic-plain-part",
  "src": "前文 <span style=\"font: 15px serif\">简写正常 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-weight: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\"><i>简写</i></span><span style=\"font: 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">正常 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 15px serif\">*简写*</span><span style=\"font: 15px serif\">正常 here</span> 后面 words"
 },
 {
  "name": "sh-italic-bold-part",
  "src": "前文 <span style=\"font: bold 15px serif\">简写粗体 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-weight: bold; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 15px serif&quot;}\"><i>简写</i></span><span style=\"font: bold 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 15px serif&quot;}\">粗体 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: bold 15px serif\">*简写*</span><span style=\"font: bold 15px serif\">粗体 here</span> 后面 words"
 },
 {
  "name": "sh-unbold-italic-bold",
  "src": "前文 <span style=\"font: italic bold 15px serif\">简写粗斜 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: italic; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: italic bold 15px serif&quot;}\">简写</span><span style=\"font: italic bold 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: italic bold 15px serif&quot;}\">粗斜 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: italic 15px serif\">简写</span><span style=\"font: italic bold 15px serif\">粗斜 here</span> 后面 words"
 },
 {
  "name": "sh-unitalic-italic-bold",
  "src": "前文 <span style=\"font: italic bold 15px serif\">简写粗斜 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-weight: bold; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: italic bold 15px serif&quot;}\">简写</span><span style=\"font: italic bold 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: italic bold 15px serif&quot;}\">粗斜 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: bold 15px serif\">简写</span><span style=\"font: italic bold 15px serif\">粗斜 here</span> 后面 words"
 },
 {
  "name": "sh-unbold-700",
  "src": "前文 <span style=\"font: 700 16px/1.5 serif; color: red\">简写七百 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: 1.5; font-family: serif; color: red;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 700 16px/1.5 serif; color: red&quot;}\">简写</span><span style=\"font: 700 16px/1.5 serif; color: red\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 700 16px/1.5 serif; color: red&quot;}\">七百 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 16px/1.5 serif; color: red\">简写</span><span style=\"font: 700 16px/1.5 serif; color: red\">七百 here</span> 后面 words"
 },
 {
  "name": "lh-unbold-part",
  "src": "前文 <span style=\"font-weight: bold\">粗体文字 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-weight: bold\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight: bold&quot;}\">粗体</span><span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight: bold&quot;}\">文字</span><span style=\"font-weight: bold\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight: bold&quot;}\"> here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font-weight: bold\">粗体</span><span>文字</span> <span style=\"font-weight: bold\">here</span> 后面 words"
 },
 {
  "name": "n1-bold-in-bold-parent",
  "src": "**粗 <span style=\"font: 15px serif\">简写正常 here</span> 后** words",
  "html": "<p data-l=\"0\"><strong>粗 <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">简写</span><span style=\"font: 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">正常 here</span> 后</strong> words</p>\n",
  "want": "**粗 <span style=\"font: bold 15px serif\">简写</span><span style=\"font: 15px serif\">正常 here</span> 后** words"
 },
 {
  "name": "n2-unbold-in-bold-parent",
  "src": "**粗 <span style=\"font: bold 16px serif\">简写粗体 here</span> 后** words",
  "html": "<p data-l=\"0\"><b>粗 </b><span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">简写</span><span style=\"font: bold 16px serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">粗体 here</span><b> 后</b> words</p>\n",
  "want": "**粗** <span style=\"font: 16px serif\">简写</span><span style=\"font: bold 16px serif\">粗体 here</span> **后** words"
 },
 {
  "name": "n3-lh-unbold-in-bold-parent",
  "src": "**粗 <span style=\"font-weight: bold\">粗体文字 here</span> 后** words",
  "html": "<p data-l=\"0\"><b>粗 </b><span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight: bold&quot;}\">粗体</span><span style=\"font-weight: bold;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight: bold&quot;}\">文字 here</span><b> 后</b> words</p>\n",
  "want": "**粗** <span>粗体</span><span style=\"font-weight: bold\">文字 here</span> **后** words"
 },
 {
  "name": "n4-bold-light",
  "src": "前文 <span style=\"font: 300 15px serif\">简写细体 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 300 15px serif&quot;}\"><b>简写</b></span><span style=\"font: 300 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 300 15px serif&quot;}\">细体 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 15px serif\">**简写**</span><span style=\"font: 300 15px serif\">细体 here</span> 后面 words"
 },
 {
  "name": "n5-unbold-across",
  "src": "前文 <span style=\"font: bold 16px serif\">甲乙</span><span style=\"font: bold 16px serif\">丙丁</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font: bold 16px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">甲</span><span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">乙</span><span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">丙</span><span style=\"font: bold 16px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: bold 16px serif&quot;}\">丁</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: bold 16px serif\">甲</span><span style=\"font: 16px serif\">乙</span><span style=\"font: 16px serif\">丙</span><span style=\"font: bold 16px serif\">丁</span> 后面 words"
 },
 {
  "name": "n6-unbold-whole-ib",
  "src": "前文 <span style=\"font: italic bold 15px serif\">简写粗斜</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: italic; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: italic bold 15px serif&quot;}\">简写粗斜</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: italic 15px serif\">简写粗斜</span> 后面 words"
 },
 {
  "name": "n7-unitalic-whole",
  "src": "前文 <span style=\"font: italic 15px serif\">简写斜体</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-weight: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: italic 15px serif&quot;}\">简写斜体</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 15px serif\">简写斜体</span> 后面 words"
 },
 {
  "name": "n8-bold-whole-plain",
  "src": "前文 <span style=\"font: 15px serif\">简写正常</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\"><b>简写正常</b></span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 15px serif\">**简写正常**</span> 后面 words"
 },
 {
  "name": "n10-sh-then-lh",
  "src": "前文 <span style=\"font: 16px serif; font-weight: bold\">混合粗体 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 16px serif; font-weight: bold&quot;}\">混合</span><span style=\"font: 16px serif; font-weight: bold\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 16px serif; font-weight: bold&quot;}\">粗体 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 16px serif\">混合</span><span style=\"font: 16px serif; font-weight: bold\">粗体 here</span> 后面 words"
 },
 {
  "name": "n11-lh-normal-bold-part",
  "src": "前文 <span style=\"font-weight: normal\">正常文字 here</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight: normal&quot;}\"><b>正常</b></span><span style=\"font-weight: normal\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight: normal&quot;}\">文字 here</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font-weight: normal\">**正常**</span><span style=\"font-weight: normal\">文字 here</span> 后面 words"
 },
 {
  "name": "n12-bold-across-plain",
  "src": "前文 <span style=\"font: 15px serif\">甲乙</span><span style=\"font: 15px serif\">丙丁</span> 后面 words",
  "html": "<p data-l=\"0\">前文 <span style=\"font: 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">甲</span><b><span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">乙</span><span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">丙</span></b><span style=\"font: 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">丁</span> 后面 words</p>\n",
  "want": "前文 <span style=\"font: 15px serif\">甲</span>**<span style=\"font: bold 15px serif\">乙</span><span style=\"font: bold 15px serif\">丙</span>**<span style=\"font: 15px serif\">丁</span> 后面 words"
 },
 {
  "name": "n13-in-italic-parent",
  "src": "*斜 <span style=\"font: 15px serif\">简写正常 here</span> 后* words",
  "html": "<p data-l=\"0\"><em>斜 <span style=\"font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-weight: normal; font-stretch: normal; font-size: 15px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">简写</span><span style=\"font: 15px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font: 15px serif&quot;}\">正常 here</span> 后</em> words</p>\n",
  "want": "*斜 <span style=\"font: italic 15px serif\">简写</span><span style=\"font: 15px serif\">正常 here</span> 后* words"
 }
];

function write(src: string, html: string, which: "tree" | "pre" = "tree"): string {
  const w = document.createElement("section");
  w.className = "md-block";
  w.innerHTML = html;
  document.body.replaceChildren(w);
  const ser = which === "tree" ? { serializeBlock, sourceStyleHints } : (pre7 as unknown as { serializeBlock: typeof serializeBlock; sourceStyleHints: typeof sourceStyleHints });
  return ser.serializeBlock(w, BlockKind.Prose, { ...ser.sourceStyleHints(src), stamped: true, editing: true });
}
const q = "&quot;";
const ps = (style: string): string => `data-mdr-o="" data-mdr-ps="{${q}style${q}:${q}${style}${q}}"`;
/** Chromium's live style after it took font-weight off a `font: <size> <family>` shorthand (expanded, less the weight). */
const EXPANDED = (size: string, family: string, style = "font-style: normal; "): string => `${style}font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: ${size}; line-height: normal; font-family: ${family};`;

describe("P2: a format command on a font-shorthand span edits the shorthand (Chromium's DOMs)", () => {
  for (const f of FIXTURES) it(f.name, () => { expect(write(f.src, f.html), f.html).toBe(f.want); });
  it("no longhand of the shorthand is ever written that the source did not have", () => {
    for (const f of FIXTURES) {
      const props = (s: string): Set<string> => new Set([...s.matchAll(/style="([^"]*)"/g)].flatMap((m) => m[1].split(";").map((d) => d.split(":")[0].trim()).filter(Boolean)));
      const had = props(f.src);
      for (const p of props(write(f.src, f.html))) expect(had.has(p), `${f.name}: ${p}`).toBe(true);
    }
  });
  it("without the change (pre-r7, the released 0.2.0) the un-bold and un-italic of a shorthand are not what the session showed", () => {
    for (const n of ["sh-unbold-part", "sh-unbold-whole", "sh-unitalic-part", "sh-unbold-700", "n5-unbold-across", "n6-unbold-whole-ib", "n7-unitalic-whole"]) {
      const f = FIXTURES.find((x) => x.name === n)!;
      expect(write(f.src, f.html, "pre"), n).not.toBe(f.want);
    }
  });
});

describe("P2: the edit itself", () => {
  const P = (style: string, live: string): string => `<p>前文 <span style="${live}" ${ps(style)}>简写</span> 后面 words</p>`;
  const S = (style: string): string => `前文 <span style="${style}">简写</span> 后面 words`;
  const cases: Array<[string, string, string, string]> = [
    // [name, record, live (after the command), written]
    ["the spelling of the rest is kept (no space after the colon, a trailing semicolon)", "font:bold 16px serif;", EXPANDED("16px", "serif"), "font:16px serif;"],
    ["a quoted family with a semicolon inside", "font: bold 16px 'A;B', serif", EXPANDED("16px", "'A;B', serif"), "font: 16px 'A;B', serif"],
    ["oblique with its angle is taken out whole", "font: oblique 10deg 15px serif", EXPANDED("15px", "serif", "").replace("font-stretch", "font-weight: normal; font-stretch"), "font: 15px serif"],
    ["a longhand weight after the shorthand goes with the un-bold", "font: 16px serif; font-weight: 700; color: red", EXPANDED("16px", "serif") + " color: red;", "font: 16px serif; color: red"],
    ["other declarations keep their bytes", "color: red ; font: bold 16px serif ; background: url(a;b.png)", "color: red; " + EXPANDED("16px", "serif") + " background: url('a;b.png');", "color: red ; font: 16px serif ; background: url(a;b.png)"],
  ];
  for (const [name, rec, live, want] of cases) it(name, () => { expect(write(S(rec), P(rec, live))).toBe(S(want)); });
  const fallback: Array<[string, string]> = [
    ["a system font keyword", "font: caption"],
    ["!important", "font: bold 16px serif !important"],
    ["var()", "font: var(--f)"],
  ];
  for (const [name, rec] of fallback) {
    it(`a shorthand this edit does not read takes the round-6 path: ${name}`, () => {
      // (the round-6 path in jsdom: CSSOM sees no font-weight in such a record, so the record is written as it is)
      expect(write(S(rec), P(rec, EXPANDED("16px", "serif")))).toBe(write(S(rec), P(rec, EXPANDED("16px", "serif")), "pre"));
    });
  }
  it("an element whose live style still has the property keeps the record (nothing changed for it)", () => {
    const rec = "font: bold 16px serif";
    expect(write(S(rec), P(rec, "font: bold 16px serif;"))).toBe(S(rec));
  });
  it("an absent live attribute (the clean-up of a join) keeps the record", () => {
    const html = `<p>前文 <span ${ps("font: bold 16px serif")}>简写</span> 后面 words</p>`;
    expect(write(S("font: bold 16px serif"), html)).toBe(S("font: bold 16px serif"));
  });
});
