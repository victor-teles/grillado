# See before you choose: option previews

## Open decisions

The interview stopped at the round cap, after round 2 of 2.

- Recover the exact numerical per-preview size limits approved in round 2; the confirmed state does not include the proposed values.

## Problem

Labels and descriptions can make it hard to judge how an option will look or work. Users need to see concrete previews, compare alternatives, and make a choice without losing Grillado’s keyboard-driven planning flow.

## Solution

Add optional UI, code, and diagram previews to question options. Show compact previews inline and provide a full-width Compare overlay. On phones, show one comparison preview at a time with Previous and Next controls. Users can select an option in Compare and submit the round separately.

Ship all three preview kinds, Compare, and Show me another together. Show me another requests one additional option and preview, reveals it, and preserves the current selection. Keep previews and added options in session history, and include chosen preview source in the saved plan.

## User stories

1. As a planner, I want previews when seeing an option helps, so that I can make a more informed choice.
2. As a planner, I want UI mockups, highlighted caller-side code sketches, and Mermaid diagrams, so that I can evaluate different kinds of decisions concretely.
3. As a planner, I want every option in a visual question to use the same preview kind, so that I can compare alternatives fairly.
4. As a planner, I want bounded inline previews, so that I can scan options before opening Compare.
5. As a planner, I want a full-width comparison view with options side by side, so that I can inspect their differences.
6. As a phone user, I want Previous and Next controls showing one comparison preview at a time, so that previews remain readable on a narrow screen.
7. As a keyboard user, I want number-key selection and separate round submission to keep working, so that previews do not slow down answering.
8. As a planner, I want to select an option inside Compare without submitting the round, so that I can review my answers before sending them.
9. As a planner, I want to request another option until the question has six options, so that I can explore an additional alternative.
10. As a planner, I want the added option revealed without changing my current selection, so that exploration does not discard my choice.
11. As a planner, I want an explanation when a preview fails while its text option remains usable, so that rendering problems do not block planning.
12. As a planner, I want previews and added options restored after reload, so that I can resume comparing where I left off.
13. As a planner, I want chosen preview source included in the saved plan, so that the visual or technical intent remains available for implementation.
14. As a planner, I want previews to reflect the project’s existing look when available, so that alternatives are relevant to my product.
15. As a planner, I want isolated previews that work at 390 px, in dark and light themes, and with assistive technology, so that I can use them safely and comfortably.

## Implementation decisions

- Deliver the complete slice: UI, code, and diagram previews plus Compare and Show me another. Do not split the initial release into a smaller feature subset. [R1:delivery-scope]
- Extend the core question and option contracts, agent prompts, and reply validation to support previews during question rounds and explicit option requests. Plan generation does not generate new previews. Preserve the existing Zod validation and single repair retry contract. [R1:preview-run-kinds]
- Use three preview variants: self-contained HTML and CSS for UI, a short highlighted sketch of the caller’s side for code, and Mermaid for diagrams. Reuse the existing diagram renderer and Mermaid checker. Previews remain optional per question. [R1:delivery-scope]
- Treat agent-written content as untrusted. Render UI previews only inside sandboxed iframes with opaque origins, no scripts, and a content security policy blocking every network request. Never share the application’s origin or session access with preview content. Keep project access read-only and write no product code. [R1:delivery-scope]
- Adopt the roomier preview budget and enforce explicit per-preview limits at the validation boundary. The numerical limits referred to as proposed limits are absent from the confirmed state and must be recovered before this contract is finalized. [R1:preview-size-budget] [R2:preview-size-limits]
- For a question with previews, require every option to supply the same preview kind, including newly requested options. A failed preview may degrade to a text-only option under the failure policy. [R2:preview-option-coverage] [R2:preview-failure-policy]
- Show bounded inline previews before Compare is opened, preserving readable option labels, descriptions, and number-key selection. [R2:preview-default-presentation]
- Implement Compare as a full-width overlay, showing alternatives side by side where space permits. On phones, show one preview at a time with explicit Previous and Next controls. [R3:preview-presentation] [R1:phone-comparison]
- Connect selection inside Compare to the question’s existing selection state. Selecting an option must not submit the round; round submission remains a separate action. [R1:comparison-selection]
- Implement Show me another as one agent call that appends one additional option with a preview. Stop offering further additions when the question reaches six options. [R2:another-option-cap] [R1:preview-run-kinds]
- Reveal the appended option while retaining the user’s current selection. [R3:another-option-behavior]
- Keep an option selectable through its label and description when its preview is invalid or cannot render. Explain the preview failure without adding a dedicated preview retry action. [R2:preview-failure-policy] [R3:preview-failure-handling]
- Persist previews and appended options as part of session history, restoring them on reload. [R2:preview-session-retention]
- Include chosen preview source in the saved plan, preserving the selected artifact’s intent across UI, code, and diagram variants. [R1:saved-preview-format]
- Guide the agent to use project fonts, colors, and component names when found through read-only project context. Keep the preview experience keyboard-first, usable at 390 px, compatible with dark and light themes, and free of axe violations. [R1:delivery-scope]

```decision
id: R1·1
key: delivery-scope
question: Should the first release include all three preview kinds and both new actions?
answer: Ship the complete slice
note: Ship all three preview kinds and both Compare and Show me another in the first release.
by: you
kept_suggestion: true
at: 2026-11-26T02:04:49.874Z
```

```decision
id: R1·2
key: preview-run-kinds
question: Should previews be generated during question rounds and explicit option requests?
answer: Questions and option requests
note: Generate previews during question rounds and explicit option requests.
by: you
kept_suggestion: true
at: 2026-11-26T02:04:49.874Z
```

```decision
id: R1·3
key: preview-size-budget
question: Should previews use compact, explicit size limits?
answer: Roomier limits
note: Use roomier preview size limits.
by: you
kept_suggestion: false
at: 2026-11-26T02:04:49.874Z
```

```decision
id: R1·4
key: saved-preview-format
question: Should the saved plan include the chosen preview as source?
answer: Chosen preview source
note: Include the chosen preview as source in the saved plan.
by: you
kept_suggestion: true
at: 2026-11-26T02:04:49.874Z
```

```decision
id: R1·5
key: phone-comparison
question: On phones, should Compare show one option at a time with explicit navigation?
answer: Previous and next controls
note: On phones, show one comparison preview at a time with Previous and Next controls.
by: you
kept_suggestion: true
at: 2026-11-26T02:04:49.874Z
```

```decision
id: R1·6
key: comparison-selection
question: Should Compare let users select an option while keeping round submission separate?
answer: Select inside Compare
note: Allow selection inside Compare while keeping round submission separate.
by: you
kept_suggestion: true
at: 2026-11-26T02:04:49.874Z
```

```decision
id: R2·1
key: preview-size-limits
question: Should we use these roomier limits for each preview?
answer: Use proposed limits
note: Adopt the proposed roomier per-preview limits, whose numerical values are absent from the confirmed state.
by: you
kept_suggestion: true
at: 2026-11-26T02:06:39.037Z
```

```decision
id: R2·2
key: preview-option-coverage
question: Should a visual question give every option the same kind of preview?
answer: Same kind throughout
note: Give every option in a visual question the same preview kind.
by: you
kept_suggestion: true
at: 2026-11-26T02:06:39.037Z
```

```decision
id: R2·3
key: another-option-cap
question: Should Show me another append an option until the question reaches six options?
answer: Append up to six
note: Show me another appends one option until the question reaches six options.
by: you
kept_suggestion: true
at: 2026-11-26T02:06:39.037Z
```

```decision
id: R2·4
key: preview-failure-policy
question: Should an invalid preview leave its option available as text?
answer: Keep text options usable
note: Keep text options usable when their previews are invalid.
by: you
kept_suggestion: true
at: 2026-11-26T02:06:39.037Z
```

```decision
id: R2·5
key: preview-session-retention
question: Should previews and added options survive reloads as part of session history?
answer: Retain with session
note: Retain previews and added options in session history so they survive reloads.
by: you
kept_suggestion: true
at: 2026-11-26T02:06:39.037Z
```

```decision
id: R2·6
key: preview-default-presentation
question: Should previews appear inline before the user opens Compare?
answer: Show bounded inline previews
note: Show bounded inline previews before the user opens Compare.
by: you
kept_suggestion: true
at: 2026-11-26T02:06:39.037Z
```

```decision
id: R3·1
key: preview-failure-handling
question: Should a failed preview show an explanation without adding a separate retry action?
answer: Explain the failure
note: Explain preview failures without adding a separate retry action.
by: you
kept_suggestion: true
at: 2026-11-26T02:15:42.191Z
```

```decision
id: R3·2
key: another-option-behavior
question: Should Show me another reveal the new option while preserving the current selection?
answer: Reveal, preserve selection
note: Reveal a newly added option while preserving the current selection.
by: you
kept_suggestion: true
at: 2026-11-26T02:15:42.191Z
```

```decision
id: R3·3
key: preview-presentation
question: Should Compare open as a full-width overlay?
answer: Full-width overlay
note: Open Compare as a full-width overlay.
by: you
kept_suggestion: true
at: 2026-11-26T02:15:42.191Z
```

## Testing decisions

- At the agent reply and validation boundary, cover all three preview kinds, ordinary text questions, consistent preview kinds within a question, malformed content, and the existing single repair retry. Once numerical budgets are available, test previews at and beyond each limit.
- At the option-request boundary, use fake agent CLIs to verify that one request produces one additional option, additions stop at six, the new option is revealed, and the prior selection remains unchanged. A failed preview must leave the returned text option usable.
- At the browser isolation boundary, verify that UI previews cannot execute scripts, make network requests, access the parent application, or read its session data. Exercise hostile agent content across all preview kinds and saved-plan presentation.
- Through browser interactions, verify bounded inline previews, opening and closing Compare, side-by-side desktop comparison, mobile Previous and Next navigation, selection inside Compare, number-key selection, and separate Enter submission. Assert visible choices and submitted answers rather than component internals.
- Verify that invalid and unrenderable previews show an understandable explanation, retain selectable text, and expose no separate preview retry action.
- Across a session reload, verify that preview content and added options remain available. Inspect saved plans to confirm that chosen preview source is retained for each preview kind.
- Inspect desktop and 390 px layouts in dark and light themes. Check preview readability, overflow, focus entry and return, keyboard operation, accessible control names, and axe results. Reuse the existing diagram checks and rendering tests where applicable.

## Out of scope

- Generating new previews during plan-generation runs.
- Executing scripts or permitting network requests inside UI previews.
- Writing product code or modifying the project repository.
- Dedicated preview retry controls.
- Adding options beyond six per question.
- Mixing preview kinds within one visual question.
- Requiring previews for every question.
- Splitting the first release into a partial slice.

## Assumptions and open decisions

- No answer was recorded as “I don’t know,” so there are no uncertainty-derived assumptions.
- Open: recover the exact numerical preview size limits approved as “Use proposed limits.” The confirmed state establishes roomier, explicit limits but does not contain their values; do not invent them.
