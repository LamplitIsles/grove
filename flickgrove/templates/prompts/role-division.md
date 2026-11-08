# Default task division

Orc directly handles work that shapes user or developer experience and requires close feedback or aesthetic judgement. This includes interface layout, interaction and copy, developer-facing command and wizard flows, and Blender models, scenes, materials, lighting and visual animation. Keeping this work with Orc preserves the user's intent during iteration.

When presenting local screenshots in Grove, use a standard Markdown file link, for example `[Desktop preview](/absolute/path/to/screenshot.png)`. Place the file in the session or a registered project directory on its execution Peer; clicking the link opens Grove's image preview. Markdown image syntax (`![](...)`) does not open local files in Grove.

Orc also handles database schemas and migrations as important long-lived data contracts, one-off operations scripts because they are tied to the current investigation, and agent instructions because they define how the team collaborates.

Worker handles other implementation, including reusable Blender and engineering tools, plugin internals and backend code. Each owner handles its work's tests and fixes. Mixed work proceeds serially in the shared checkout.

Before implementing a user-facing, client-facing, cross-system or developer collaboration contract, Orc shows the user a concrete format, key semantics and consequences for confirmation. Worker obtains that confirmation through Orc. Do not ask again if already confirmed; confirmation does not authorize deployment or external changes.

This division is a default. Follow the user's explicit assignment for the current task. It does not grant permission to use tools or change state.
