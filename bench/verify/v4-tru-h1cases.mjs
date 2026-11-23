// bench/verify/v4-tru-h1cases.mjs — verify-trust: hand-made H1 variations (CONTRACT §11, U15) written as a JSON corpus
// for bench/verify/v4-tru-diff.mjs (V4_CORPUS). Each document puts a reserved name where the scan sees no literal name
// in a raw token, or where the browser's parser reads text across token or container boundaries.
//   node bench/verify/v4-tru-h1cases.mjs <out.json> && V4_CORPUS=<out.json> MDR_PORT=5433 node bench/verify/v4-tru-diff.mjs
import { writeFileSync } from 'node:fs';
const C = (n) => String.fromCharCode(n);
const NBSP = C(0xa0), FF = C(12), VT = C(11), NUL = C(0);
const names = ['data-l=1', 'data-lang=x', 'data-md=1', 'data-mdr-x', 'class=md-math', "class='md-math'", 'class="x md-block"'];
const docs = [];
for (const n of names) {
  docs.push(
    // a tag cut across list items / quote lines / table cells (glued containers)
    `- <b title='\n- ${n} x='y'>z`,
    `- <b title="\n  ${n} x="y">z`,
    `> <b title='\n> ${n} y='\n> q'>`,
    `| a |\n|---|\n| <b title=' | ${n} '> |`,
    `# <b title='\n${n}'>`,
    `[<b title='](x) ${n} '>](y)`,
    `*<b title='* ${n} '>*`,
    // across a soft break, in one paragraph
    `a <b title='x\n${n} '>z`,
    // html_block cut by a blank line inside a glued container
    `- <div title='\n\n  ${n} x='q'\n\n  </div>`,
    `> <div title="\n>\n> ${n} x="q"\n>\n> </div>`,
    `<details>\n<summary title='\n\n${n} '>s</summary>\n</details>`,
    // markdown text that LOOKS like it continues a tag (no raw token open)
    `<b>x</b> <i ${n}`,
    `<b x="a">y</b>${n}`,
    // tokens that markdown-it closes but the browser keeps open (Unicode whitespace in markdown-it's \\s)
    `x <b${NBSP}x="' y='q"> ${n} '>`,
    `x <b title=${NBSP}'>'> ${n} '>`,
    `x <b${VT}title='a'> ${n} '`,
    `x <b title='a'${NBSP}y='> ${n} '>`,
    // processing instructions / declarations / CDATA ending differently for markdown-it and the browser
    `x <?a>b?> <b title='?> ${n} '>`,
    `x <!a b='> ${n} '>`,
    `x <![CDATA[ a ]]> <b title='> ${n} '>`,
    `x <!-- a --!> <b title='--> ${n} '>`,
    `x <!---> <b title='--> ${n} '>`,
    // html_block types closing on a later line than the browser thinks
    `<pre>\n</pre x='\n${n} '>\n</pre>`,
    `<style>\n</style x='\n${n} '>\n</style>`,
    `<script>\n</script x='\n${n} '>\n</script>`,
    `<textarea>\n</textarea x='\n${n} '>\n</textarea>`,
    `<!--\n--!>\n<b title='\n${n} '>\n-->`,
    // references in names and values
    `<b class=&#x6d;d-math>x</b>`, `<b class="&#109;&#100;-math">x</b>`, `<b class="x&Tab;md-math">x</b>`,
    `<b class="x&NewLine;md-block">x</b>`, `<b class="&#x20md-math">x</b>`, `<b class="&#32md-math">x</b>`,
    `<b class="a&#x0Cmd-math">x</b>`, `<b class="a&#13;md-math">x</b>`, `<b clas&#115;="md-math">x</b>`,
    `<b data-&#108;=1>x</b>`, `<b ${n.replace('-', '&#45;')}>x</b>`,
    // entities in text read as attributes after an open tag
    `- <b title='\n- &#100;ata-l=1 '>`, `- <b \n- class=&#x6d;d-math>z`,
    // fence info / heading / link title / alt
    '```' + n + '\ncode\n```', `# ${n}`, `[a](x "${n}")`, `![${n}](x.png)`, `- [ ] ${n}`,
    // math
    `$\\htmlClass{md-math}{x}$`, `$\\htmlData{l=1}{x}$`, `$\\text{${n}}$`, `$$\n\\htmlClass{md-block}{y}\n$$`,
  );
}
writeFileSync(process.argv[2], JSON.stringify(docs));
console.log(`${docs.length} documents`);
