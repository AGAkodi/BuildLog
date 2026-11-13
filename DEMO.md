# Live demo checklist

Live URL: https://buildlog.akodi-buildlog.workers.dev/

Before recording: verify GitHub and Buffer OAuth callbacks match the public hostname; use a real public repository with a meaningful merged PR; connect a supported Buffer channel; confirm that the queue has no duplicate of the intended post. Check public site access in a fresh browser. Never expose OAuth tokens, client secrets, or authorization callback query strings.

Suggested recording (under 120 seconds):
- 0–15 seconds: Explain that builders ship work but finding and writing a trustworthy update takes time. Show the landing page.
- 15–35 seconds: Sign in with GitHub and connect Buffer using OAuth, showing the real connected channel.
- 35–55 seconds: Enter a public GitHub repository, select an actual merged pull request, and open its source.
- 55–80 seconds: Show the editable title- or commit-message-based draft and merged-not-live warning. Explain that the user checks and edits claims.
- 80–105 seconds: Approve and queue a distinct, reviewed post to the chosen channel.
- 105–120 seconds: Open Buffer and verify that the queued post appears. Explain that queued does not mean published.

Only show a live queue action if the user has reviewed and intends to schedule the content. If Buffer rejects a duplicate, use a genuinely distinct update or show the existing confirmed queue item rather than suggesting a failed request succeeded.

Honest scope: current drafts are templates based on pull request titles or commit messages; the app links to the source but does not analyze diffs or automatically verify each claim. Do not claim AI generation, automatic code verification, deployment detection, or duplicate announcement detection.
