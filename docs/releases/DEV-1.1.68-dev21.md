# DevSpace Portable 1.1.68 dev21

* Disabling automatic continuation makes ordinary MCP calls and the initial status probe headless and observational. These calls stop creating or reactivating continuation ledgers. Explicitly tracked manual tasks remain available.
* The continuation page shows only unfinished eligible automatic tasks by default. When disabled, previous records are available through the history option. Stale RUNNING rows with completed milestones display their completion separately from the stored state.
