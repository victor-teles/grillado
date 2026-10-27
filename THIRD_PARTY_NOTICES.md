# Third-party notices

## Interview and plan instructions

Grillado's interview and plan-writing instructions (`src/core/prompts.ts`) are adapted from
the `grilling`, `grill-me` and `to-spec` skills in https://github.com/mattpocock/skills
(commit 5beb35b040e3de97e54fa9e386d7e42d15c295c2), used under the MIT License:

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## UI components

Components under `web/src/components/ui/` come from shadcn/ui (https://ui.shadcn.com, MIT,
Copyright (c) 2023 shadcn) and the uai registry (https://uaiblocks.dev,
https://github.com/victor-teles/uai, MIT, Copyright (c) 2026 Victor Mesquita).

`web/src/components/ui/uai/agent-question.tsx` is vendored from uai PR #56 (stacked layout,
commit ed7da38) until that change is released; the same MIT terms apply.

## Fonts

`web/src/fonts/` ships two variable fonts (Latin subset, WOFF2, bundled into `dist/web/assets`;
nothing is loaded from a CDN). Both are under the SIL Open Font License 1.1, reproduced below
and in `web/src/fonts/OFL-*.txt`:

- Inter, Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter).
- Geist Mono, Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font).

The fonts are not sold on their own and keep their reserved names.

<details><summary>SIL Open Font License, Version 1.1</summary>

```
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

</details>

## Bundled packages

The published `dist/` bundles React, Radix UI, lucide-react, Tailwind CSS, Zod and other
MIT/ISC-licensed packages listed in `package.json` (devDependencies). Their license comments
are preserved in the bundles.

## MCP server (`grillado mcp`)

`dist/cli.js` bundles the official MCP TypeScript SDK, @modelcontextprotocol/sdk
(https://github.com/modelcontextprotocol/typescript-sdk, MIT, Copyright (c) 2024 Anthropic, PBC),
with the dependencies it pulls in: ajv, ajv-formats, fast-deep-equal and json-schema-traverse
(MIT), zod-to-json-schema (ISC) and fast-uri (BSD-3-Clause).

## Markdown editor (CodeMirror)

The plan editor's Markdown view uses CodeMirror 6 (https://codemirror.net, MIT, Copyright (C)
2018-2021 by Marijn Haverbeke and others). It is loaded only when the Markdown view opens and is
bundled into `dist/web/assets/` with its dependencies, all MIT: @codemirror/view, @codemirror/state,
@codemirror/commands, @codemirror/language, @codemirror/lang-markdown (and the language packages
it pulls in), @lezer/common, @lezer/lr, @lezer/highlight, @lezer/markdown, crelt, style-mod,
w3c-keyname, @marijn/find-cluster-break.

## Diagrams (Mermaid)

The plan editor renders ```` ```mermaid ```` blocks with Mermaid (https://github.com/mermaid-js/mermaid,
MIT, Copyright (c) 2014 - 2022 Knut Sveidqvist). It is loaded only when a plan has a diagram and
is bundled into `dist/web/assets/` with its dependencies, under these licenses:

- MIT: @braintree/sanitize-url, @iconify/utils, @mermaid-js/parser, @upsetjs/venn.js, cytoscape,
  cytoscape-cose-bilkent, cytoscape-fcose, cose-base, layout-base, dagre-d3-es, dayjs, es-toolkit,
  katex, khroma, lodash-es, marked, roughjs (and hachure-fill, path-data-parser, points-on-curve,
  points-on-path), stylis, ts-dedent, uuid.
- ISC: d3 and its d3-* modules, d3-sankey, internmap, delaunator.
- Apache-2.0: chevrotain and its @chevrotain/* packages.
- MPL-2.0 OR Apache-2.0: DOMPurify (used here under Apache-2.0).
- BSD-3-Clause: rw.
- Unlicense: robust-predicates.

The build writes the full license text of every npm package in the web bundle (Mermaid's
dependencies included) to `dist/web/third-party-licenses.txt` (`scripts/licenses-plugin.ts`). Grillado does **not** ship elkjs (EPL-2.0):
the import is replaced by a stub (`web/src/vendor/elk-stub.js`) and Mermaid is configured to
use its dagre layout for every diagram.
