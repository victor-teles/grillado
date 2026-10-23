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
commit 5120fb7) until that change is released; the same MIT terms apply.

## Fonts

`web/src/fonts/` ships two variable fonts (Latin subset, WOFF2), both under the SIL Open Font
License 1.1 (https://openfontlicense.org):

- Inter, Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter).
- Geist Mono, Copyright (c) 2023 Vercel, in collaboration with basement.studio
  (https://github.com/vercel/geist-font).

The fonts are not sold on their own and keep their reserved names.

## Bundled packages

The published `dist/` bundles React, Radix UI, lucide-react, Tailwind CSS, Zod and other
MIT/ISC-licensed packages listed in `package.json` (devDependencies). Their license comments
are preserved in the bundles.
