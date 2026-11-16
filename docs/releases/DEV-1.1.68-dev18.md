# DevSpace Portable 1.1.68 dev18

* The Electron Next Computer Use broker executes input sequences serially, checks the live lease and request lifetime between steps, and takes one optional screenshot at the end. On partial failure it identifies the failed step and the confirmed prefix. Capture errors are reported separately after successful input.
* The in-process Agent Runtime receives functional MCP tool descriptions without ChatGPT conversation-control instructions. External MCP clients continue to receive the conversation contract and use the same registered handlers.
* Agent task deadlines now cover backend queue wait and inference. Expired requests return a task-budget error, and a request that expires while queued is removed without starting inference.
