# DevSpace Portable 1.1.62 dev2 — compact Host-native card

Development release, built only in the original E-drive source checkout.
The ChatGPT internal native-card renderer is not a public third-party API.
The supported integration is MCP Apps: the Host manages the outer surface
(ui.prefersBorder=false for continuation resources), HTML provides a native
details/summary row, and the optional public ChatGPT bridge continues
to handle fullscreen and widget-state persistence. Other MCP Hosts retain
functional fallbacks and normal review cards retain their existing border.

The card opens as a one-line task headline with a small completed/total
milestone count and progress indicator, rather than a long debug panel.
The full diagnostic content is built only on explicit expansion; a model
status heartbeat neither rebuilds the large diagnostics nor invokes tools.
No existing continuation sender, ACK, turn-completion or permission rules
are relaxed. End-to-end turn latency is still governed by Host and network
delivery and is not proven improved by a lower DOM render cost.

Acceptance: the existing card-disclosure browser test (updated for default
collapse, explicit expand, new-generation identity and frozen historical
cards), Host-interactions VM test, canonical self-contained App resource test,
all continuation guards and complete source suite must pass. Preserve D-live
data/configuration/process state and do not use a second C-drive worktree.
