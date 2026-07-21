# Scenebook product context

Scenebook is a local-first system for documenting, verifying, reviewing, and publishing complete product journeys. It is for developers, product teams, support teams, and vibecoders who need durable walkthroughs backed by real product evidence.

## Primary jobs

1. Capture or author one complete outcome as a scene.
2. Review the latest run evidence and understand what needs attention.
3. Organize scenes into collections for a specific audience.
4. Export reviewed source into an explicit release pipeline.
5. Publish accessible walkthroughs without leaking private capture data.

The default user should always be able to find a scene, continue editing it, identify the first blocker, and export it without understanding the full schema.

## Product principles

- Local work stays in the browser until the user explicitly imports, exports, or publishes it.
- Authored source, run evidence, approval, and publication are distinct states. Never imply that one proves another.
- Put the current task first. Reveal identifiers, hashes, policies, formats, and pipeline details only when requested.
- Preserve portability: canonical source and evidence must remain inspectable outside the Studio UI.
- Prefer exact, calm language over slogans or trust claims.
- Never hide an advanced capability permanently; place it behind a clearly named disclosure or task screen.

## Terminology

- **scene**: one ordered product journey.
- **step**: one moment in a scene.
- **run evidence**: captured proof from executing a scene.
- **review**: a human decision about a change or run.
- **collection**: an ordered group of scenes.
- **channel**: release policy and destination configuration.
- **release**: the gated process that turns reviewed source into published output.

Use lowercase domain nouns in prose. Reserve schema capitalization and raw IDs for file, code, and evidence-detail contexts.

## Non-goals

Scenebook is not an HTML-cloning tool, full video editor, CRM, knowledge base, silent self-healing runner, native-app capture system, or general-purpose hosted browser executor.
